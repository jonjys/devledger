//! Fields the user names themselves.
//!
//! Whatever the built-in fields do not cover -- a customer number, a support
//! PIN, the username on some forum, which project a plan is paid for -- a
//! person can attach to a person, an account, a project or a resource, under a
//! name they choose.

mod common;

use devledger_core::model::{EntityKind, EntityRef, Environment, Provider};
use devledger_core::secret::{SecretBytes, SecretString};
use devledger_core::store::Store;
use devledger_core::CoreError;

fn account(vault: &devledger_core::Vault) -> (uuid::Uuid, uuid::Uuid) {
    let me = vault
        .create_identity_manual("Me", Some("me@example.com"))
        .expect("identity");
    let acc = vault
        .create_account_manual(me.id, Provider::Other("Loopia".into()), "Domains")
        .expect("account");
    (me.id, acc.id)
}

#[test]
fn any_label_the_user_chooses_can_be_attached_to_an_account() {
    let (_dir, vault) = common::unlocked_vault();
    let (_me, acc) = account(&vault);
    let on_account = EntityRef::new(EntityKind::Account, acc);

    vault
        .add_custom_field(&on_account, "Customer number", "LP-448812")
        .expect("add");
    vault
        .add_custom_field(&on_account, "Project", "Storefront")
        .expect("add");
    vault
        .add_custom_field(&on_account, "Forum username", "acme_dev")
        .expect("add");

    let fields = vault.custom_fields(&on_account).expect("list");
    let pairs: Vec<_> = fields
        .iter()
        .map(|f| (f.label.as_str(), f.value.as_str()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("Customer number", "LP-448812"),
            ("Project", "Storefront"),
            ("Forum username", "acme_dev"),
        ],
        "kept in the order they were added"
    );
}

#[test]
fn fields_work_on_people_projects_and_resources_too() {
    let (_dir, vault) = common::unlocked_vault();
    let (me, acc) = account(&vault);
    let project = vault.create_project("Storefront", None).expect("project");
    let resource = vault
        .create_service_project_manual(
            acc,
            None,
            Provider::Other("Loopia".into()),
            "acme.se",
            None,
            Environment::Production,
        )
        .expect("resource");

    for (entity, label) in [
        (EntityRef::new(EntityKind::Identity, me), "Phone"),
        (EntityRef::new(EntityKind::Project, project.id), "Repo"),
        (
            EntityRef::new(EntityKind::ServiceProject, resource.id),
            "Renews",
        ),
    ] {
        vault
            .add_custom_field(&entity, label, "value")
            .unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(vault.custom_fields(&entity).expect("list").len(), 1);
    }
}

#[test]
fn a_field_can_be_renamed_and_changed() {
    let (_dir, vault) = common::unlocked_vault();
    let (_me, acc) = account(&vault);
    let on_account = EntityRef::new(EntityKind::Account, acc);
    let field = vault
        .add_custom_field(&on_account, "Pin", "1234")
        .expect("add");

    vault
        .update_custom_field(field.id, "Support PIN", "9876")
        .expect("update");

    let fields = vault.custom_fields(&on_account).expect("list");
    assert_eq!(fields[0].label, "Support PIN");
    assert_eq!(fields[0].value, "9876");
}

#[test]
fn a_nameless_field_or_one_on_nothing_is_refused() {
    let (_dir, vault) = common::unlocked_vault();
    let (_me, acc) = account(&vault);

    let err = vault
        .add_custom_field(&EntityRef::new(EntityKind::Account, acc), "  ", "x")
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "got {err:?}");

    let err = vault
        .add_custom_field(
            &EntityRef::new(EntityKind::Account, uuid::Uuid::new_v4()),
            "Pin",
            "1",
        )
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "got {err:?}");

    let err = vault
        .add_custom_field(
            &EntityRef::new(EntityKind::Secret, uuid::Uuid::new_v4()),
            "Pin",
            "1",
        )
        .unwrap_err();
    assert!(
        matches!(err, CoreError::Invalid(_)),
        "secrets carry no fields: {err:?}"
    );
}

#[test]
fn deleting_a_person_takes_every_field_under_them_with_it() {
    // Fields have no foreign key (their owner can be one of four tables), so
    // triggers clean up. This checks the harder case: the account is removed by
    // the identity's cascade, not deleted directly, and its fields still go.
    let (_dir, vault) = common::unlocked_vault();
    let (me, acc) = account(&vault);
    vault
        .add_custom_field(&EntityRef::new(EntityKind::Identity, me), "Phone", "1")
        .expect("add");
    vault
        .add_custom_field(&EntityRef::new(EntityKind::Account, acc), "Pin", "2")
        .expect("add");

    vault.delete_identity(me).expect("delete");

    let store = vault.store_for_test().expect("store");
    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM custom_fields")
            .unwrap(),
        0,
        "no field is left pointing at a deleted row"
    );
}

#[test]
fn a_field_value_never_reaches_the_audit_log() {
    let (_dir, vault) = common::unlocked_vault();
    let (_me, acc) = account(&vault);
    vault
        .add_custom_field(
            &EntityRef::new(EntityKind::Account, acc),
            "Recovery hint",
            "first-dog-was-rex",
        )
        .expect("add");

    let audit = vault.recent_audit(20).expect("audit");
    assert!(audit.iter().any(|e| e.detail.contains("Recovery hint")));
    assert!(audit
        .iter()
        .all(|e| !e.detail.contains("first-dog-was-rex")));
}

#[test]
fn upgrading_a_v4_vault_keeps_its_data_and_adds_fields() {
    let mut store =
        Store::open_in_memory_at_version(&SecretBytes::new(vec![9u8; 32]), 4).expect("v4");
    store
        .execute_batch_for_test(
            "INSERT INTO identities (id, label, created_at)
                VALUES ('11111111-1111-4111-a111-111111111111', 'me', '2026-01-01T00:00:00Z');
             INSERT INTO accounts (id, identity_id, provider, label, created_at)
                VALUES ('22222222-2222-4222-a222-222222222222',
                        '11111111-1111-4111-a111-111111111111', 'other:Loopia', 'Domains',
                        '2026-01-01T00:00:00Z');",
        )
        .expect("seed v4");

    store.migrate_now().expect("v4 -> current");

    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM accounts")
            .unwrap(),
        1,
        "existing rows survive"
    );
    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM custom_fields")
            .unwrap(),
        0,
        "and the new table is there, empty"
    );
}

#[test]
fn a_secret_field_is_just_a_secret_on_the_same_account() {
    // The UI's "hide this value" choice stores the field as a sealed secret
    // owned by the account. Nothing new is needed for that; this pins it down.
    use devledger_core::manual::NewSecret;
    use devledger_core::model::SecretKind;
    use devledger_core::store::SecretOwner;

    let (_dir, mut vault) = common::unlocked_vault();
    let (_me, acc) = account(&vault);
    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    account_id: Some(acc),
                    ..SecretOwner::default()
                },
                kind: SecretKind::EnvVar,
                name: "Support PIN".into(),
                environment: Environment::Unknown,
                notes: None,
            },
            &SecretString::new("9876"),
        )
        .expect("store");
    let listed = vault.account_secrets(acc).expect("list");
    assert_eq!(listed[0].secret.name, "Support PIN");
    assert_ne!(listed[0].secret.preview, "9876", "shown masked");
}
