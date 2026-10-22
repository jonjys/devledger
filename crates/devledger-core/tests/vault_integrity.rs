//! An incomplete vault must fail to open instead of becoming a new empty one.

mod common;

use std::fs;

use devledger_core::crypto::kdf::KdfParams;
use devledger_core::secret::SecretString;
use devledger_core::{CoreError, Vault};
use tempfile::TempDir;

#[test]
fn a_missing_database_is_not_recreated_and_a_complete_restore_keeps_the_data() {
    let (dir, mut vault) = common::unlocked_vault();
    let project = vault
        .create_project("Existing project", None)
        .expect("project");
    let database = vault.db_path();
    vault.lock();
    let saved_database = fs::read(&database).expect("backup closed database");
    fs::remove_file(&database).expect("simulate incomplete restore");

    let mut reopened = Vault::new(dir.path());
    let error = reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect_err("a sidecar without its database must not open");
    assert!(matches!(error, CoreError::Storage(_)), "{error:?}");
    assert!(!reopened.is_unlocked());
    assert!(
        !database.exists(),
        "unlock must not create a replacement database"
    );

    fs::write(&database, saved_database).expect("restore original database");
    reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect("a complete restored vault opens");
    let projects = reopened.list_projects().expect("list restored projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].project.id, project.id);
}

#[test]
fn an_empty_database_is_not_reinitialized() {
    let (dir, mut vault) = common::unlocked_vault();
    let database = vault.db_path();
    vault.lock();
    fs::write(&database, []).expect("simulate truncated database");

    let mut reopened = Vault::new(dir.path());
    let error = reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect_err("an empty database must not open");
    assert!(matches!(error, CoreError::Storage(_)), "{error:?}");
    assert!(!reopened.is_unlocked());
    assert_eq!(fs::metadata(&database).expect("database metadata").len(), 0);
}

#[test]
fn initializing_never_changes_an_orphan_database_or_its_sidecars() {
    let dir = TempDir::new().expect("temporary vault directory");
    let mut vault = Vault::new(dir.path());
    let files = [
        "devledger.db",
        "devledger.db-wal",
        "devledger.db-shm",
        "keep.txt",
    ];
    for name in files {
        fs::write(dir.path().join(name), format!("original {name}")).expect("existing file");
    }

    let error = vault
        .initialize_with_params(
            &SecretString::new(common::PASSPHRASE),
            KdfParams::weak_for_tests().expect("KDF parameters"),
        )
        .expect_err("an existing orphan database must not be replaced or removed");
    assert!(matches!(error, CoreError::Storage(_)), "{error:?}");
    assert!(!vault.is_initialized());
    assert!(!vault.is_unlocked());
    for name in files {
        assert_eq!(
            fs::read_to_string(dir.path().join(name)).expect("original file remains"),
            format!("original {name}")
        );
    }
}

#[test]
fn initializing_preserves_orphan_sqlite_sidecars_even_without_a_database() {
    let dir = TempDir::new().expect("temporary vault directory");
    let mut vault = Vault::new(dir.path());
    let sidecar = dir.path().join("devledger.db-wal");
    fs::write(&sidecar, b"existing encrypted pages").expect("orphan sidecar");

    let error = vault
        .initialize_with_params(
            &SecretString::new(common::PASSPHRASE),
            KdfParams::weak_for_tests().expect("KDF parameters"),
        )
        .expect_err("orphan encrypted pages must be preserved");
    assert!(matches!(error, CoreError::Storage(_)), "{error:?}");
    assert!(!vault.db_path().exists());
    assert!(!vault.meta_path().exists());
    assert_eq!(
        fs::read(sidecar).expect("sidecar remains"),
        b"existing encrypted pages"
    );
}
