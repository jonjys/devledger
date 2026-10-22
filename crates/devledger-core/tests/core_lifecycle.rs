//! The everyday manual flow, including correcting a mistaken connection and
//! recovering the closed vault's encrypted files in a fresh directory.

mod common;

use std::fs;

use devledger_core::manual::NewSecret;
use devledger_core::model::{Environment, Provider, SecretKind};
use devledger_core::secret::SecretString;
use devledger_core::store::{AccountDetails, SecretOwner};
use devledger_core::vault::{DB_FILE, META_FILE};
use devledger_core::{CoreError, Vault};
use tempfile::TempDir;

#[test]
fn corrected_manual_project_survives_restart_and_encrypted_file_restore() {
    let (dir, mut vault) = common::unlocked_vault();
    let project = vault.create_project("Storefront", None).expect("project");
    let wrong_project = vault
        .create_project("Unrelated project", None)
        .expect("unrelated project");
    let personal = vault
        .create_identity_manual("Personal", Some("personal@example.com"))
        .expect("personal identity");
    let work = vault
        .create_identity_manual("Work", Some("work@example.com"))
        .expect("work identity");
    let mut accounts = Vec::new();
    for (identity, email, label) in [
        (personal.id, "personal@example.com", "Personal database"),
        (work.id, "work@example.com", "Work database"),
    ] {
        accounts.push(
            vault
                .create_account_with_details(
                    identity,
                    Provider::Supabase,
                    label,
                    &AccountDetails {
                        login_email: Some(email.into()),
                        ..AccountDetails::default()
                    },
                )
                .expect("account"),
        );
    }
    let resource = vault
        .create_service_project_manual(
            accounts[0].id,
            None,
            Provider::Supabase,
            "Storefront database",
            Some("synthetic-storefront"),
            Environment::Production,
        )
        .expect("resource");
    vault
        .link_service_project(resource.id, wrong_project.id)
        .expect("initial mistaken link");

    for (owner, kind, name, environment, value) in [
        (
            SecretOwner {
                service_project_id: Some(resource.id),
                ..SecretOwner::default()
            },
            SecretKind::PostgresConnectionString,
            "DATABASE_URL",
            Environment::Production,
            "postgres://synthetic:production@db.example.com/storefront",
        ),
        (
            SecretOwner {
                service_project_id: Some(resource.id),
                ..SecretOwner::default()
            },
            SecretKind::PostgresConnectionString,
            "DATABASE_URL",
            Environment::Development,
            "postgres://synthetic:development@localhost/storefront",
        ),
        (
            SecretOwner {
                project_id: Some(project.id),
                ..SecretOwner::default()
            },
            SecretKind::EnvVar,
            "APP_LABEL",
            Environment::Production,
            "Storefront #1",
        ),
        (
            SecretOwner {
                account_id: Some(accounts[1].id),
                ..SecretOwner::default()
            },
            SecretKind::Password,
            "ACCOUNT_PASSWORD",
            Environment::Production,
            "synthetic-account-password",
        ),
    ] {
        vault
            .store_secret(
                &NewSecret {
                    owner,
                    kind,
                    name: name.into(),
                    environment,
                    notes: None,
                },
                &SecretString::new(value),
            )
            .expect("store synthetic secret");
    }

    // Correct both the owning account and the project that uses the resource.
    vault
        .move_service_project(resource.id, accounts[1].id, None)
        .expect("correct owning account");
    vault
        .unlink_service_project(resource.id, wrong_project.id)
        .expect("remove mistaken project link");
    vault
        .link_service_project(resource.id, project.id)
        .expect("link correct project");
    assert!(vault
        .list_secrets(wrong_project.id)
        .expect("unrelated secrets")
        .is_empty());
    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].service_project.account_id, accounts[1].id);
    assert_eq!(
        resources[0].identity_email.as_deref(),
        Some("work@example.com")
    );
    assert_eq!(resources[0].used_by.len(), 1);
    assert_eq!(resources[0].used_by[0].id, project.id);

    // A mixed export must refuse the two different DATABASE_URL values.
    assert!(matches!(
        vault.export_env(project.id),
        Err(CoreError::Invalid(_))
    ));
    let expected_env = concat!(
        "APP_LABEL=\"Storefront #1\"\n",
        "DATABASE_URL=postgres://synthetic:production@db.example.com/storefront\n",
    );
    assert_eq!(
        vault
            .export_env_for_environment(project.id, Some(Environment::Production))
            .expect("production export")
            .expose(),
        expected_env
    );
    let expected_graph = vault.identity_graph().expect("graph");
    let expected_projects = vault.list_projects().expect("projects");
    let expected_secrets = vault.list_all_secrets().expect("all secrets");
    vault.lock();
    drop(vault);

    let mut reopened = Vault::new(dir.path());
    reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect("unlock after restart");
    assert_eq!(
        reopened.identity_graph().expect("reopened graph"),
        expected_graph
    );
    assert_eq!(
        reopened.list_projects().expect("reopened projects"),
        expected_projects
    );
    assert_eq!(
        reopened.list_all_secrets().expect("reopened secrets"),
        expected_secrets
    );
    reopened.lock();

    // Desktop currently has no backup command. This verifies the file
    // storage boundary: copying both files of a CLOSED vault is recoverable.
    let backup = TempDir::new().expect("backup directory");
    let restored_dir = TempDir::new().expect("restore directory");
    for name in [META_FILE, DB_FILE] {
        fs::copy(dir.path().join(name), backup.path().join(name)).expect("copy backup file");
        fs::copy(backup.path().join(name), restored_dir.path().join(name))
            .expect("restore backup file");
    }
    let mut restored = Vault::new(restored_dir.path());
    assert!(matches!(
        restored.unlock(&SecretString::new("wrong-backup-passphrase")),
        Err(CoreError::InvalidPassphrase)
    ));
    restored
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect("unlock restored vault");
    assert_eq!(
        restored.identity_graph().expect("restored graph"),
        expected_graph
    );
    assert_eq!(
        restored.list_projects().expect("restored projects"),
        expected_projects
    );
    assert_eq!(
        restored.list_all_secrets().expect("restored secrets"),
        expected_secrets
    );
    assert_eq!(
        restored
            .export_env_for_environment(project.id, Some(Environment::Production))
            .expect("restored production export")
            .expose(),
        expected_env
    );
    assert!(restored
        .list_secrets(wrong_project.id)
        .expect("restored unrelated project")
        .is_empty());
}
