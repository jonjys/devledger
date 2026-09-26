//! M3: SQLCipher persistence and the vault lifecycle.
//!
//! The headline properties: the database file is genuinely encrypted at rest,
//! a wrong passphrase cannot open it, locking really does remove the ability to
//! decrypt, the audit log cannot be rewritten, and a reviewed paste turns into
//! the Identity -> Account -> Organization -> Project chain it implied.

mod common;

use std::fs;

use devledger_core::crypto::kdf::KdfParams;
use devledger_core::model::{EntityKind, EntityRef, Provider, RelationKind};
use devledger_core::paste::review::{EntityDecision, ReviewDecision, ReviewSubmission};
use devledger_core::redact::SourceKind;
use devledger_core::secret::SecretString;
use devledger_core::store::AttentionKind;
use devledger_core::{CoreError, Vault};
use tempfile::TempDir;

use common::accept_all;

#[test]
fn a_new_vault_initializes_unlocked_and_persists() {
    let dir = TempDir::new().expect("temp dir");
    let mut vault = Vault::new(dir.path());
    assert!(!vault.is_initialized());
    assert!(!vault.is_unlocked());

    vault
        .initialize_with_params(
            &SecretString::new(common::PASSPHRASE),
            KdfParams::weak_for_tests().expect("params"),
        )
        .expect("initialize");

    assert!(vault.is_initialized());
    assert!(vault.is_unlocked());
    assert!(vault.meta_path().exists());
    assert!(vault.db_path().exists());

    let status = vault.status();
    assert!(status.initialized && status.unlocked);
}

#[test]
fn initializing_twice_is_refused() {
    let (_dir, mut vault) = common::unlocked_vault();
    let err = vault
        .initialize_with_params(
            &SecretString::new(common::PASSPHRASE),
            KdfParams::weak_for_tests().expect("params"),
        )
        .unwrap_err();
    assert!(matches!(err, CoreError::AlreadyInitialized));
}

#[test]
fn a_short_passphrase_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let mut vault = Vault::new(dir.path());
    let err = vault
        .initialize_with_params(
            &SecretString::new("short"),
            KdfParams::weak_for_tests().expect("params"),
        )
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)));
    assert!(
        !vault.is_initialized(),
        "a refused init must leave no vault behind"
    );
}

#[test]
fn unlock_round_trips_and_a_wrong_passphrase_is_rejected() {
    let (dir, mut vault) = common::unlocked_vault();
    vault.lock();
    assert!(!vault.is_unlocked());

    let mut reopened = Vault::new(dir.path());
    let err = reopened
        .unlock(&SecretString::new("definitely-not-the-passphrase"))
        .unwrap_err();
    assert!(matches!(err, CoreError::InvalidPassphrase), "got {err:?}");
    assert!(!reopened.is_unlocked());

    reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect("correct passphrase opens the vault");
    assert!(reopened.is_unlocked());
}

#[test]
fn unlocking_a_directory_with_no_vault_is_refused() {
    let dir = TempDir::new().expect("temp dir");
    let mut vault = Vault::new(dir.path());
    let err = vault
        .unlock(&SecretString::new(common::PASSPHRASE))
        .unwrap_err();
    assert!(matches!(err, CoreError::NotInitialized));
}

#[test]
fn the_database_file_is_encrypted_at_rest() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let submission = accept_all(&analysis);
    vault.commit_review(&submission).expect("commit");
    let db_path = vault.db_path();
    vault.lock();

    let bytes = fs::read(&db_path).expect("read db");
    assert!(!bytes.is_empty());

    // A plaintext SQLite file starts with this header; a SQLCipher one does not.
    assert!(
        !bytes.starts_with(b"SQLite format 3\0"),
        "the vault must not be a readable SQLite database"
    );
    // And none of the pasted material is recoverable by grepping the file.
    for needle in [
        b"s3cr3t-pw".as_slice(),
        b"SUPABASE_SERVICE_ROLE_KEY".as_slice(),
        b"abcdefghijklmnopqrst".as_slice(),
    ] {
        assert!(
            !bytes.windows(needle.len()).any(|w| w == needle),
            "found {:?} in the encrypted database file",
            String::from_utf8_lossy(needle)
        );
    }
}

#[test]
fn locking_removes_the_ability_to_read_anything() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");
    let project_id = outcome.touched_project_ids[0];
    let secret_id = vault.list_secrets(project_id).expect("list")[0].secret.id;

    vault.lock();

    assert!(matches!(
        vault.list_projects().unwrap_err(),
        CoreError::VaultLocked
    ));
    assert!(matches!(
        vault.reveal_secret(secret_id).unwrap_err(),
        CoreError::VaultLocked
    ));
    assert!(matches!(
        vault.export_env(project_id, None).unwrap_err(),
        CoreError::VaultLocked
    ));
}

#[test]
fn the_audit_log_cannot_be_rewritten() {
    let (_dir, vault) = common::unlocked_vault();
    let before = vault.recent_audit(50).expect("audit");
    assert!(
        before.iter().any(|e| e.action == "vault.initialize"),
        "initialization is recorded"
    );

    // The append-only guarantee is enforced by database triggers, so even a
    // direct UPDATE or DELETE against audit_log must be refused.
    let err = vault.attempt_audit_mutation().unwrap_err();
    match &err {
        CoreError::Storage(message) => {
            assert!(
                message.contains("append-only"),
                "expected the trigger's message, got {message:?}"
            );
        }
        other => panic!("expected a storage error, got {other:?}"),
    }

    vault.create_project("probe", None).expect("create project");
    let after = vault.recent_audit(50).expect("audit");
    assert!(after.len() > before.len(), "the log only grows");
    assert!(
        after.iter().all(|e| e.detail != "tampered"),
        "no row was rewritten"
    );
    // Sequence numbers are strictly decreasing in a newest-first read.
    for pair in after.windows(2) {
        assert!(pair[0].seq > pair[1].seq);
    }
}

#[test]
fn committing_a_paste_builds_the_full_entity_chain() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    assert!(!analysis.blocks_save);

    // The chain DevLedger proposes is the one a person would draw by hand.
    assert_eq!(
        analysis.chain.identity.as_ref().map(|n| n.label.as_str()),
        Some("dev-a@example.com")
    );
    assert_eq!(
        analysis.chain.account.as_ref().map(|n| n.label.as_str()),
        Some("Supabase")
    );
    assert_eq!(
        analysis
            .chain
            .organization
            .as_ref()
            .map(|n| n.label.as_str()),
        Some("AcmeOrg")
    );
    assert_eq!(
        analysis
            .chain
            .service_project
            .as_ref()
            .map(|n| n.label.as_str()),
        Some("abcdefghijklmnopqrst")
    );
    assert_eq!(
        analysis.chain.project.as_ref().map(|n| n.label.as_str()),
        Some("Acme Storefront")
    );

    // The two names it could not verify are asked about rather than assumed.
    let ids: Vec<&str> = analysis.questions.iter().map(|q| q.id.as_str()).collect();
    assert!(ids.contains(&"project"));
    assert!(ids.contains(&"organization"));

    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");

    assert_eq!(outcome.secrets_created, 3);
    assert_eq!(outcome.projects_created, 1);
    assert_eq!(outcome.service_projects_created, 1);
    assert_eq!(outcome.identities_created, 1);
    assert_eq!(outcome.accounts_created, 1);
    assert_eq!(outcome.organizations_created, 1);
    assert_eq!(outcome.left_unassigned, 0, "the organization was confirmed");

    let projects = vault.list_projects().expect("projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].project.name, "Acme Storefront");
    assert_eq!(projects[0].secret_count, 3);
    assert_eq!(projects[0].service_project_count, 1);

    // The provider resource is a separate row, under the named organization.
    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    let resource = &resources[0];
    assert_eq!(
        resource.service_project.provider_ref.as_deref(),
        Some("abcdefghijklmnopqrst")
    );
    assert_eq!(resource.organization_name.as_deref(), Some("AcmeOrg"));
    assert_eq!(
        resource.identity_email.as_deref(),
        Some("dev-a@example.com")
    );
    assert_eq!(resource.secret_count, 3);
    assert_eq!(resource.used_by.len(), 1);
    assert_eq!(resource.used_by[0].name, "Acme Storefront");

    // And the graph reads back in the same shape.
    let graph = vault.identity_graph().expect("graph");
    assert_eq!(graph.len(), 1);
    assert_eq!(
        graph[0].identity.email.as_deref(),
        Some("dev-a@example.com")
    );
    assert_eq!(graph[0].accounts.len(), 1);
    assert_eq!(graph[0].accounts[0].account.provider, Provider::Supabase);
    assert_eq!(graph[0].accounts[0].organizations.len(), 1);
    assert_eq!(
        graph[0].accounts[0].organizations[0].organization.name,
        "AcmeOrg"
    );
    assert_eq!(
        graph[0].accounts[0].organizations[0].service_projects.len(),
        1
    );
    assert!(graph[0].accounts[0].unassigned.is_empty());
}

#[test]
fn a_paste_that_names_no_organization_leaves_it_unassigned() {
    // A bare .env block: credentials, but nothing saying who owns them.
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_ENV, SourceKind::SmartPaste)
        .expect("analyze");

    assert!(
        analysis.chain.organization.is_none(),
        "nothing in the paste names an organization"
    );

    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");
    assert_eq!(
        outcome.organizations_created, 0,
        "an unknown organization must never be invented"
    );
    assert_eq!(outcome.left_unassigned, 1);

    let resources = vault.list_service_projects().expect("resources");
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0].organization_name, None);

    // And DevLedger says so, rather than leaving it silently wrong.
    let attention = vault.needs_attention().expect("attention");
    assert!(attention
        .iter()
        .any(|a| a.kind == AttentionKind::UnassignedOrganization));
}

#[test]
fn a_revealed_secret_round_trips_exactly() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");

    let entries = vault
        .list_secrets(outcome.touched_project_ids[0])
        .expect("list");
    let database_url = entries
        .iter()
        .find(|e| e.secret.name == "DATABASE_URL")
        .expect("DATABASE_URL stored");

    // The listing itself carries only a masked preview.
    assert!(!database_url.secret.preview.contains("s3cr3t-pw"));

    let revealed = vault.reveal_secret(database_url.secret.id).expect("reveal");
    assert!(revealed.expose().contains("s3cr3t-pw"));
    assert!(revealed.expose().starts_with("postgresql://"));

    // The reveal is audited.
    let audit = vault.recent_audit(10).expect("audit");
    assert!(audit.iter().any(|e| e.action == "secret.reveal"));
}

#[test]
fn a_duplicate_paste_is_recognised_and_skipped() {
    let (_dir, mut vault) = common::unlocked_vault();
    let first = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    vault.commit_review(&accept_all(&first)).expect("commit");

    // The identical paste, a second time.
    let second = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    assert!(
        second
            .warnings
            .iter()
            .any(|w| w.code == devledger_core::paste::WarningCode::DuplicateSecret),
        "the blind index must recognise the stored values"
    );
    let outcome = vault.commit_review(&accept_all(&second)).expect("commit");
    assert_eq!(outcome.secrets_created, 0, "nothing new to store");
    assert_eq!(outcome.secrets_updated, 0);

    let projects = vault.list_projects().expect("projects");
    assert_eq!(projects.len(), 1, "no duplicate project was created");
    assert_eq!(projects[0].secret_count, 3);
    assert_eq!(
        vault.list_service_projects().expect("resources").len(),
        1,
        "no duplicate resource was created"
    );
}

#[test]
fn a_rotated_value_updates_the_existing_secret() {
    let (_dir, mut vault) = common::unlocked_vault();
    let first = vault
        .analyze_paste("Acme Storefront\nSupabase\nAPI_TOKEN=ghp_0123456789abcdefghij0123456789abcdefgh\nURL=https://abcdefghijklmnopqrst.supabase.co", SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&first)).expect("commit");
    assert_eq!(outcome.secrets_created, 1);
    let project_id = outcome.touched_project_ids[0];

    // Same name, different value.
    let second = vault
        .analyze_paste("Acme Storefront\nSupabase\nAPI_TOKEN=ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\nURL=https://abcdefghijklmnopqrst.supabase.co", SourceKind::SmartPaste)
        .expect("analyze");
    assert!(second
        .warnings
        .iter()
        .any(|w| w.code == devledger_core::paste::WarningCode::SecretRotated));

    let outcome = vault.commit_review(&accept_all(&second)).expect("commit");
    assert_eq!(outcome.secrets_updated, 1);
    assert_eq!(outcome.secrets_created, 0);

    let entries = vault.list_secrets(project_id).expect("list");
    let token = entries
        .iter()
        .find(|e| e.secret.name == "API_TOKEN")
        .expect("token");
    let revealed = vault.reveal_secret(token.secret.id).expect("reveal");
    assert!(
        revealed.expose().ends_with("zzzz"),
        "the new value is stored"
    );

    let audit = vault.recent_audit(50).expect("audit");
    assert!(audit.iter().any(|e| e.action == "secret.rotate"));
}

#[test]
fn a_critical_warning_blocks_save_until_acknowledged() {
    let (_dir, mut vault) = common::unlocked_vault();
    let text = "Acme Storefront\nSupabase\nNEXT_PUBLIC_SERVICE_ROLE_KEY=sb_secret_abcdefghijklmnop\nURL=https://abcdefghijklmnopqrst.supabase.co";
    let analysis = vault
        .analyze_paste(text, SourceKind::SmartPaste)
        .expect("analyze");
    assert!(analysis.blocks_save);

    let mut submission = accept_all(&analysis);
    let err = vault.commit_review(&submission).unwrap_err();
    assert!(
        matches!(err, CoreError::Invalid(_)),
        "the backend must enforce the block, not just the UI"
    );

    // The staged analysis survives a refused commit, so the user can acknowledge
    // and retry without re-pasting.
    submission.acknowledge_critical = true;
    let outcome = vault.commit_review(&submission).expect("commit");
    assert_eq!(outcome.secrets_created, 1);
}

#[test]
fn a_staged_analysis_cannot_be_committed_twice() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let submission = accept_all(&analysis);
    vault.commit_review(&submission).expect("first commit");

    let err = vault.commit_review(&submission).unwrap_err();
    assert!(matches!(err, CoreError::StaleAnalysis(_)));
}

#[test]
fn a_discarded_analysis_writes_nothing() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    vault
        .discard_analysis(analysis.analysis_id)
        .expect("discard");

    assert!(vault.list_projects().expect("projects").is_empty());
    let err = vault.commit_review(&accept_all(&analysis)).unwrap_err();
    assert!(matches!(err, CoreError::StaleAnalysis(_)));
}

#[test]
fn env_export_is_produced_backend_side_and_is_valid() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");

    let env = vault
        .export_env(outcome.touched_project_ids[0], None)
        .expect("export");
    let text = env.expose();

    assert!(text.contains("DATABASE_URL=postgresql://"));
    assert!(text.contains("s3cr3t-pw"), "the export carries real values");
    assert!(text.contains("SUPABASE_SERVICE_ROLE_KEY=eyJ"));
    assert_eq!(text.lines().count(), 3);
    // Every line is a NAME=VALUE pair.
    for line in text.lines() {
        assert!(line.contains('='), "malformed env line: {line:?}");
    }

    let audit = vault.recent_audit(10).expect("audit");
    assert!(audit.iter().any(|e| e.action == "project.export_env"));
}

#[test]
fn provenance_is_stored_alongside_a_saved_secret_and_stays_redacted() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");

    let entries = vault
        .list_secrets(outcome.touched_project_ids[0])
        .expect("list");
    let secret_id = entries[0].secret.id;
    let records = vault
        .provenance_for(EntityRef::new(EntityKind::Secret, secret_id))
        .expect("provenance");

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].source, SourceKind::SmartPaste);
    assert!(!records[0].redacted_excerpt.contains("s3cr3t-pw"));
    assert!(records[0].redacted_excerpt.contains("[REDACTED:"));
}

#[test]
fn a_secret_can_be_deleted_and_stops_resolving() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");
    let project_id = outcome.touched_project_ids[0];

    let secret_id = vault.list_secrets(project_id).expect("list")[0].secret.id;
    vault.delete_secret(secret_id).expect("delete");

    assert_eq!(vault.list_secrets(project_id).expect("list").len(), 2);
    assert!(matches!(
        vault.reveal_secret(secret_id).unwrap_err(),
        CoreError::NotFound(_)
    ));
}

#[test]
fn reopening_a_vault_sees_everything_that_was_saved() {
    let dir = TempDir::new().expect("temp dir");
    let project_id;
    {
        let mut vault = Vault::new(dir.path());
        vault
            .initialize_with_params(
                &SecretString::new(common::PASSPHRASE),
                KdfParams::weak_for_tests().expect("params"),
            )
            .expect("initialize");
        let analysis = vault
            .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
            .expect("analyze");
        let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");
        project_id = outcome.touched_project_ids[0];
    }

    let mut reopened = Vault::new(dir.path());
    reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect("unlock");

    let projects = reopened.list_projects().expect("projects");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].project.id, project_id);
    assert_eq!(projects[0].secret_count, 3);

    let entries = reopened.list_secrets(project_id).expect("list");
    let db = entries
        .iter()
        .find(|e| e.secret.name == "DATABASE_URL")
        .expect("found");
    let revealed = reopened.reveal_secret(db.secret.id).expect("reveal");
    assert!(
        revealed.expose().contains("s3cr3t-pw"),
        "migrations are idempotent and data survives"
    );
}

#[test]
fn vault_entries_flag_which_secrets_are_unsafe_for_clients() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");

    let entries = vault
        .list_secrets(outcome.touched_project_ids[0])
        .expect("list");
    let anon = entries
        .iter()
        .find(|e| e.secret.name == "NEXT_PUBLIC_SUPABASE_ANON_KEY")
        .expect("anon key");
    let service = entries
        .iter()
        .find(|e| e.secret.name == "SUPABASE_SERVICE_ROLE_KEY")
        .expect("service key");

    assert!(!anon.client_unsafe, "anon keys are meant for clients");
    assert!(service.client_unsafe, "service_role keys are not");
}

#[test]
fn accepted_relations_point_at_the_rows_that_were_actually_created() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");
    let outcome = vault.commit_review(&accept_all(&analysis)).expect("commit");
    assert!(outcome.relations_created > 0);

    let project_id = outcome.touched_project_ids[0];
    let resource = vault.list_service_projects().expect("resources")[0]
        .service_project
        .clone();

    let relations = vault
        .relations_for(EntityRef::new(EntityKind::ServiceProject, resource.id))
        .expect("relations");

    // Secrets authenticate to the provider resource, and the resource is used
    // by the DevLedger project. Neither is a self-link.
    let secret_ids: Vec<_> = vault
        .list_secrets(project_id)
        .expect("list")
        .into_iter()
        .map(|e| e.secret.id)
        .collect();

    let auth: Vec<_> = relations
        .iter()
        .filter(|r| r.kind == RelationKind::AuthenticatesTo)
        .collect();
    assert!(!auth.is_empty(), "credential relations were recorded");
    for relation in auth {
        assert_eq!(relation.from.kind, EntityKind::Secret);
        assert!(secret_ids.contains(&relation.from.id));
        assert_eq!(
            relation.to,
            EntityRef::new(EntityKind::ServiceProject, resource.id)
        );
        assert!(!relation.evidence.reason.is_empty());
    }

    assert!(
        relations.iter().any(|r| r.kind == RelationKind::UsedBy
            && r.to == EntityRef::new(EntityKind::Project, project_id)),
        "the resource is linked to the project that uses it"
    );

    // And the organization chain is recorded too.
    let org_relations = vault
        .relations_for(EntityRef::new(EntityKind::Project, project_id))
        .expect("relations");
    assert!(org_relations.iter().any(|r| r.kind == RelationKind::UsedBy));
}

#[test]
fn a_relation_whose_entity_was_skipped_is_dropped_with_it() {
    let (_dir, mut vault) = common::unlocked_vault();
    let analysis = vault
        .analyze_paste(common::SUPABASE_FULL, SourceKind::SmartPaste)
        .expect("analyze");

    // Skip every secret but keep every relation ticked.
    let submission = ReviewSubmission {
        analysis_id: analysis.analysis_id,
        decisions: (0..analysis.entities.len())
            .map(|entity_index| ReviewDecision {
                entity_index,
                decision: EntityDecision::Skip,
                name_override: None,
            })
            .collect(),
        accepted_relations: analysis
            .proposed_relations
            .iter()
            .map(|r| r.index)
            .collect(),
        acknowledge_critical: false,
        target_project_id: None,
        answers: common::accept_all(&analysis).answers,
    };

    let outcome = vault.commit_review(&submission).expect("commit");
    assert_eq!(outcome.secrets_created, 0);

    // The project chain is still built, so its structural Owns relation exists.
    // What must not exist is an authenticates_to relation pointing at a secret
    // that was never written.
    let project_id = outcome.touched_project_ids.first().copied();
    if let Some(project_id) = project_id {
        let relations = vault
            .relations_for(EntityRef::new(EntityKind::Project, project_id))
            .expect("relations");
        assert!(
            relations
                .iter()
                .all(|r| r.kind != devledger_core::model::RelationKind::AuthenticatesTo),
            "relations must not outlive the entities they point at"
        );
    }
}
