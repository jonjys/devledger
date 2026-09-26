//! Migration regression tests.
//!
//! These exist because two defects in the v1 -> v2 upgrade were found by
//! building a v1 database and upgrading it, not by reading the SQL. Both were
//! silent: one destroyed every stored credential while leaving the vault
//! looking intact, the other refused to open the vault at all.
//!
//! The pattern is the same each time: create a database as the *old* version
//! left it, write rows the way the old code wrote them, then run the real
//! migration path and assert on what survived.

use devledger_core::secret::SecretBytes;
use devledger_core::store::schema::CURRENT_VERSION;
use devledger_core::store::Store;

fn key() -> SecretBytes {
    SecretBytes::new(vec![7u8; 32])
}

/// A v1 database holding one account, one organization, one project, one
/// secret, and that secret's sealed value.
fn v1_with_one_secret() -> Store {
    let store = Store::open_in_memory_at_version(&key(), 1).expect("v1 database");
    store
        .execute_batch_for_test(
            "INSERT INTO identities (id, label, email, email_blind_index, created_at)
                VALUES ('11111111-1111-4111-a111-111111111111', 'dev@example.com',
                        'dev@example.com', 'bi-email', '2026-01-01T00:00:00Z');
             INSERT INTO accounts (id, identity_id, provider, label, created_at)
                VALUES ('22222222-2222-4222-a222-222222222222',
                        '11111111-1111-4111-a111-111111111111', 'supabase',
                        'Supabase', '2026-01-01T00:00:00Z');
             INSERT INTO organizations (id, account_id, provider_org_id, name, created_at)
                VALUES ('33333333-3333-4333-a333-333333333333',
                        '22222222-2222-4222-a222-222222222222', 'org_live', 'AcmeOrg',
                        '2026-01-01T00:00:00Z');
             INSERT INTO projects
                 (id, organization_id, provider_project_ref, name, environment, created_at)
                VALUES ('44444444-4444-4444-a444-444444444444',
                        '33333333-3333-4333-a333-333333333333', 'abcdefghijklmnopqrst',
                        'storefront', 'production', '2026-01-01T00:00:00Z');
             INSERT INTO secrets
                 (id, project_id, kind, name, preview, value_blind_index, environment,
                  created_at, updated_at)
                VALUES ('55555555-5555-4555-a555-555555555555',
                        '44444444-4444-4444-a444-444444444444',
                        'supabase_service_role_key', 'SUPABASE_SERVICE_ROLE_KEY',
                        'eyJh…older', 'bi-secret', 'production',
                        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO secret_values (secret_id, envelope)
                VALUES ('55555555-5555-4555-a555-555555555555', x'0102030405060708');",
        )
        .expect("seed v1 rows");
    store
}

#[test]
fn upgrading_a_v1_vault_keeps_every_sealed_value() {
    // The regression: `DROP TABLE secrets` in v2 ran with foreign keys enforced,
    // so SQLite's implicit DELETE FROM cascaded into `secret_values` and emptied
    // it. Metadata and previews survived, which made the vault look healthy
    // right up until the first Reveal or .env export.
    let mut store = v1_with_one_secret();
    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM secret_values")
            .unwrap(),
        1,
        "the v1 fixture should start with one sealed value"
    );

    store.migrate_now().expect("v1 upgrades cleanly");

    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM secret_values")
            .unwrap(),
        1,
        "the sealed value must survive the upgrade"
    );
    assert_eq!(
        store
            .scalar_for_test(
                "SELECT count(*) FROM secret_values WHERE envelope = x'0102030405060708'"
            )
            .unwrap(),
        1,
        "and it must still be the same ciphertext, byte for byte"
    );
    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM secrets")
            .unwrap(),
        1,
        "with its metadata still attached"
    );
}

#[test]
fn every_secret_keeps_a_value_after_upgrading() {
    // The sharper form of the same assertion: no secret may be left as metadata
    // with nothing to decrypt. This is what a user would actually notice.
    let mut store = v1_with_one_secret();
    store.migrate_now().expect("upgrade");

    let orphaned = store
        .scalar_for_test(
            "SELECT count(*) FROM secrets s
              WHERE NOT EXISTS (SELECT 1 FROM secret_values v WHERE v.secret_id = s.id)",
        )
        .unwrap();
    assert_eq!(orphaned, 0, "no secret may lose its sealed value");
}

#[test]
fn two_v1_projects_sharing_a_name_do_not_block_the_upgrade() {
    // v1 allowed duplicate project names; v2 added a unique index on the new
    // `projects` table. Inserting one row per resource therefore aborted the
    // whole migration, and an aborted migration means the vault will not open.
    let mut store = Store::open_in_memory_at_version(&key(), 1).expect("v1 database");
    store
        .execute_batch_for_test(
            "INSERT INTO identities (id, label, created_at)
                VALUES ('11111111-1111-4111-a111-111111111111', 'dev', '2026-01-01T00:00:00Z');
             INSERT INTO accounts (id, identity_id, provider, label, created_at)
                VALUES ('22222222-2222-4222-a222-222222222222',
                        '11111111-1111-4111-a111-111111111111', 'supabase', 'Supabase',
                        '2026-01-01T00:00:00Z');
             INSERT INTO organizations (id, account_id, name, created_at)
                VALUES ('33333333-3333-4333-a333-333333333333',
                        '22222222-2222-4222-a222-222222222222', 'AcmeOrg',
                        '2026-01-01T00:00:00Z');
             INSERT INTO projects
                 (id, organization_id, provider_project_ref, name, environment, created_at)
                VALUES ('44444444-4444-4444-a444-444444444444',
                        '33333333-3333-4333-a333-333333333333', 'ref-one', 'shop',
                        'production', '2026-01-01T00:00:00Z');
             INSERT INTO projects
                 (id, organization_id, provider_project_ref, name, environment, created_at)
                VALUES ('66666666-6666-4666-a666-666666666666',
                        '33333333-3333-4333-a333-333333333333', 'ref-two', 'Shop',
                        'staging', '2026-01-01T00:00:00Z');",
        )
        .expect("seed two same-named projects");

    store.migrate_now().expect("the upgrade must not abort");

    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM service_projects")
            .unwrap(),
        2,
        "both provider resources are carried across"
    );
    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM projects")
            .unwrap(),
        2,
        "and they stay two separate DevLedger projects rather than being merged \
         on the strength of a shared name"
    );
    assert_eq!(
        store
            .scalar_for_test(
                "SELECT count(*) FROM relations WHERE kind = 'used_by'
                   AND from_kind = 'service_project' AND to_kind = 'project'"
            )
            .unwrap(),
        2,
        "each resource is linked to its own project"
    );
    assert_eq!(
        store
            .scalar_for_test("SELECT count(DISTINCT to_id) FROM relations WHERE kind = 'used_by'")
            .unwrap(),
        2,
        "and no two resources point at the same project"
    );
}

#[test]
fn migrating_leaves_no_dangling_references() {
    // The migration runner turns foreign keys off while it works, so this is
    // the check that replaces enforcement: after upgrading, nothing may point
    // at a row that no longer exists.
    let mut store = v1_with_one_secret();
    store.migrate_now().expect("upgrade");

    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM pragma_foreign_key_check")
            .unwrap(),
        0,
        "an upgraded vault must be referentially intact"
    );
}

#[test]
fn foreign_keys_are_enforced_again_once_migration_is_done() {
    // Turning enforcement off is scoped to the upgrade. If it leaked, ordinary
    // deletes would stop cascading and the vault would accumulate orphans.
    let mut store = v1_with_one_secret();
    store.migrate_now().expect("upgrade");

    assert_eq!(
        store.scalar_for_test("PRAGMA foreign_keys").unwrap(),
        1,
        "foreign keys must be back on for normal operation"
    );
}

#[test]
fn a_fresh_vault_lands_on_the_current_version() {
    let store = Store::open_in_memory(&key()).expect("fresh database");
    assert_eq!(
        store
            .scalar_for_test("SELECT version FROM schema_version")
            .unwrap(),
        CURRENT_VERSION,
    );
}

#[test]
fn upgrading_is_idempotent() {
    let mut store = v1_with_one_secret();
    store.migrate_now().expect("first upgrade");
    store.migrate_now().expect("second upgrade is a no-op");
    store.migrate_now().expect("and so is a third");

    assert_eq!(
        store
            .scalar_for_test("SELECT count(*) FROM secret_values")
            .unwrap(),
        1,
        "re-running migrations must not touch data"
    );
    assert_eq!(
        store
            .scalar_for_test("SELECT version FROM schema_version")
            .unwrap(),
        CURRENT_VERSION,
    );
}
