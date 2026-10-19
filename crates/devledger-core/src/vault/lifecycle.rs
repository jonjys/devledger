//! Creating, unlocking and locking the vault, and the keys an unlocked vault holds.

use super::*;
use std::fs::OpenOptions;
use std::io::Write;

impl Vault {
    /// Create a handle for the vault directory. Does not touch the disk.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Vault {
            dir: dir.into(),
            inner: None,
        }
    }

    /// Path of the metadata sidecar.
    pub fn meta_path(&self) -> PathBuf {
        self.dir.join(META_FILE)
    }

    /// Path of the encrypted database.
    pub fn db_path(&self) -> PathBuf {
        self.dir.join(DB_FILE)
    }

    /// Whether a vault has been created in this directory.
    pub fn is_initialized(&self) -> bool {
        self.meta_path().exists()
    }

    /// Whether the vault is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.inner.is_some()
    }

    /// Lock state, for the UI.
    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            initialized: self.is_initialized(),
            unlocked: self.is_unlocked(),
        }
    }

    /// Create a new vault and leave it unlocked.
    pub fn initialize(&mut self, passphrase: &SecretString) -> Result<()> {
        if self.is_initialized() {
            return Err(CoreError::AlreadyInitialized);
        }
        validate_passphrase(passphrase)?;
        fs::create_dir_all(&self.dir)?;
        let params = KdfParams::generate()?;
        self.initialize_with_params(passphrase, params)
    }

    /// Create a vault with explicit KDF parameters. Used by the test suite to
    /// avoid paying the production Argon2id cost in every test.
    #[doc(hidden)]
    pub fn initialize_with_params(
        &mut self,
        passphrase: &SecretString,
        params: KdfParams,
    ) -> Result<()> {
        if self.is_initialized() {
            return Err(CoreError::AlreadyInitialized);
        }
        validate_passphrase(passphrase)?;
        fs::create_dir_all(&self.dir)?;

        let meta = VaultMeta {
            version: 1,
            kdf: params,
            created_at: crate::store::now_rfc3339()?,
        };
        let master = kdf::derive_master_key(passphrase, &meta.kdf)?;
        let unlocked = self.initialize_new_store(&master, &serde_json::to_vec_pretty(&meta)?)?;
        self.inner = Some(unlocked);
        Ok(())
    }

    /// Reserve a new database before opening SQLite. A failed initialization
    /// may remove these files only because none existed when we began.
    fn initialize_new_store(&self, master: &SecretBytes, metadata: &[u8]) -> Result<Unlocked> {
        let database_files = ["", "-wal", "-shm", "-journal"]
            .map(|suffix| self.dir.join(format!("{DB_FILE}{suffix}")));
        for path in &database_files {
            match fs::symlink_metadata(path) {
                Ok(_) => {
                    return Err(CoreError::Storage(
                        "vault database files already exist without metadata; preserve the vault folder and restore a complete backup before retrying".into(),
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        // create_new also refuses a competing initializer or a dangling symlink.
        drop(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&database_files[0])?,
        );

        let mut created_metadata = false;
        let result: Result<Unlocked> = (|| {
            let unlocked = self.open_unlocked(master)?;
            unlocked.store.audit(
                "vault.initialize",
                None,
                None,
                "Vault created and encrypted at rest",
            )?;

            // Publish the KDF metadata last, without replacing another writer's
            // file. On error the closure drops SQLite and this handle first.
            let mut sidecar = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.meta_path())?;
            created_metadata = true;
            sidecar.write_all(metadata)?;
            sidecar.sync_all()?;
            Ok(unlocked)
        })();

        if let Err(error) = result {
            // Only files belonging to this attempt can reach this cleanup.
            // Remove metadata last so a cleanup failure never discards a salt
            // while its encrypted database remains on disk.
            for path in database_files.iter().rev() {
                if let Err(cleanup) = fs::remove_file(path) {
                    if cleanup.kind() != std::io::ErrorKind::NotFound {
                        return Err(CoreError::Storage(format!(
                            "vault initialization failed ({error}); cleanup failed ({cleanup}); preserve the vault folder before retrying"
                        )));
                    }
                }
            }
            if created_metadata {
                fs::remove_file(self.meta_path())?;
            }
            return Err(error);
        }
        result
    }

    /// Derive the master key and open the encrypted store.
    pub fn unlock(&mut self, passphrase: &SecretString) -> Result<()> {
        if self.is_unlocked() {
            return Ok(());
        }
        if !self.is_initialized() {
            return Err(CoreError::NotInitialized);
        }
        // SQLite creates a new database when the path is absent (or empty).
        // Unlock must never turn an incomplete restore into an empty vault.
        let database = fs::metadata(self.db_path()).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CoreError::Storage(
                    "vault database is missing; restore the complete vault backup".into(),
                )
            } else {
                error.into()
            }
        })?;
        if !database.is_file() || database.len() == 0 {
            return Err(CoreError::Storage(
                "vault database is not a non-empty file; restore the complete vault backup".into(),
            ));
        }
        let meta: VaultMeta = serde_json::from_slice(&fs::read(self.meta_path())?)?;
        let master = kdf::derive_master_key(passphrase, &meta.kdf)?;
        let unlocked = self.open_unlocked(&master)?;
        unlocked
            .store
            .audit("vault.unlock", None, None, "Vault unlocked")?;
        self.inner = Some(unlocked);
        Ok(())
    }

    pub(super) fn open_unlocked(&self, master: &SecretBytes) -> Result<Unlocked> {
        let store = Store::open(&self.db_path(), master)?;
        Ok(Unlocked {
            store,
            aead_key: crypto::derive_subkey(master, LABEL_SECRET_AEAD)?,
            index_key: crypto::derive_subkey(master, LABEL_BLIND_INDEX)?,
            staging: HashMap::new(),
        })
    }

    /// Drop the open store, the subkeys, and every staged paste.
    pub fn lock(&mut self) {
        // Dropping `Unlocked` zeroizes both subkeys and clears staging; the
        // `Store` closes its SQLCipher connection, which wipes its page cache.
        self.inner = None;
    }

    pub(super) fn unlocked(&self) -> Result<&Unlocked> {
        self.inner.as_ref().ok_or(CoreError::VaultLocked)
    }

    pub(super) fn unlocked_mut(&mut self) -> Result<&mut Unlocked> {
        self.inner.as_mut().ok_or(CoreError::VaultLocked)
    }

    /// The open store. Errors when locked.
    pub(crate) fn store(&self) -> Result<&Store> {
        Ok(&self.unlocked()?.store)
    }

    /// The per-secret AEAD key. Errors when locked.
    pub(crate) fn aead_key(&self) -> Result<&SecretBytes> {
        Ok(&self.unlocked()?.aead_key)
    }

    /// The blind-index key. Errors when locked.
    pub(crate) fn index_key(&self) -> Result<&SecretBytes> {
        Ok(&self.unlocked()?.index_key)
    }

    /// Find or create the identity for an email address.
    pub(crate) fn identity_id_for_email(&self, email: &str) -> Result<Uuid> {
        let inner = self.unlocked()?;
        let lowered = email.trim().to_ascii_lowercase();
        let bi = blind_index::blind_index(&inner.index_key, DOMAIN_IDENTITY_EMAIL, &lowered)?;
        if let Some(id) = inner.store.identity_id_by_email_index(&bi)? {
            return Ok(id);
        }
        Ok(inner
            .store
            .create_identity(&lowered, Some(&lowered), Some(&bi))?
            .id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_creation_failure_cleans_up_only_the_new_database_and_can_be_retried() {
        let dir = tempfile::TempDir::new().expect("temporary vault directory");
        let mut vault = Vault::new(dir.path());
        let unrelated = dir.path().join("keep.txt");
        fs::write(&unrelated, b"existing unrelated file").expect("unrelated file");
        // This deterministically simulates a metadata path appearing after
        // the public initializer's initial check, on Windows and Unix alike.
        fs::create_dir(vault.meta_path()).expect("metadata creation blocker");
        let passphrase = SecretString::new("correct-horse-battery-staple");
        let params = KdfParams::weak_for_tests().expect("KDF parameters");
        let master = kdf::derive_master_key(&passphrase, &params).expect("master key");

        assert!(vault.initialize_new_store(&master, b"{}").is_err());
        assert!(!vault.is_unlocked());
        for suffix in ["", "-wal", "-shm", "-journal"] {
            assert!(!dir.path().join(format!("{DB_FILE}{suffix}")).exists());
        }
        assert!(
            vault.meta_path().is_dir(),
            "the blocker belongs to someone else"
        );
        assert_eq!(
            fs::read(&unrelated).expect("unrelated file"),
            b"existing unrelated file"
        );

        fs::remove_dir(vault.meta_path()).expect("remove our test blocker");
        vault
            .initialize_with_params(&passphrase, params)
            .expect("a failed initialization can be retried");
        vault
            .create_project("Retry succeeds", None)
            .expect("project");
        vault.lock();
        vault.unlock(&passphrase).expect("reopen the retried vault");
        assert_eq!(vault.list_projects().expect("projects").len(), 1);
    }
}
