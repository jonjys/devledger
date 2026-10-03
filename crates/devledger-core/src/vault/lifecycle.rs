//! Creating, unlocking and locking the vault, and the keys an unlocked vault holds.

use super::*;

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
        let unlocked = self.open_unlocked(&master)?;

        unlocked.store.audit(
            "vault.initialize",
            None,
            None,
            "Vault created and encrypted at rest",
        )?;

        // The sidecar is written last: if anything above failed, the directory
        // is still "not initialized" and initialize can be retried cleanly.
        fs::write(self.meta_path(), serde_json::to_vec_pretty(&meta)?)?;
        self.inner = Some(unlocked);
        Ok(())
    }

    /// Derive the master key and open the encrypted store.
    pub fn unlock(&mut self, passphrase: &SecretString) -> Result<()> {
        if self.is_unlocked() {
            return Ok(());
        }
        if !self.is_initialized() {
            return Err(CoreError::NotInitialized);
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
