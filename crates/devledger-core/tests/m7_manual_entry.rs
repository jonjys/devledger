//! Manual entry: building the whole ledger with no token and no network.
//!
//! The scenario these tests keep coming back to is the one that breaks naive
//! models: one person, two email addresses, an account with the *same* provider
//! under each, and a single project that draws on resources from both. Anything
//! that keys an account by provider alone, or an identity by a single address,
//! quietly corrupts this case rather than failing on it.

mod common;

use devledger_core::manual::{NewAccount, NewResource, NewSecret, ResourceEdit};
use devledger_core::model::{Environment, Provider, SecretKind};
use devledger_core::secret::SecretString;
use devledger_core::store::{AttentionKind, SecretOwner};
use devledger_core::{CoreError, Vault};

/// A person with one address, and an account with `service`.
fn person(vault: &Vault, email: &str, service: &str, label: &str) -> (uuid::Uuid, uuid::Uuid) {
    let identity = vault
        .create_identity(email, Some(email))
        .expect("create identity");
    let account = vault
        .create_account(&NewAccount {
            identity_id: identity.id,
            service: service.into(),
            label: label.into(),
            login_email: Some(email.into()),
            username: None,
            url: None,
            notes: None,
        })
        .expect("create account");
    (identity.id, account.id)
}

fn resource(vault: &Vault, account_id: uuid::Uuid, name: &str, env: Environment) -> uuid::Uuid {
    vault
        .create_resource(&NewResource {
            account_id,
            organization_id: None,
            name: name.into(),
            provider_ref: None,
            region: None,
            environment: env,
            url: None,
            notes: None,
        })
        .expect("create resource")
        .id
}

// --------------------------------------------------------------- identities

#[test]
fn an_identity_can_hold_several_email_addresses() {
    let (_dir, vault) = common::unlocked_vault();
    let identity = vault
        .create_identity("Me", Some("work@example.com"))
        .expect("create");

    vault
        .add_identity_email(identity.id, "personal@example.com", false)
        .expect("second address");
    vault
        .add_identity_email(identity.id, "old@example.com", false)
        .expect("third address");

    let emails = vault.identity_emails(identity.id).expect("emails");
    assert_eq!(emails.len(), 3, "one person, three addresses");
    assert_eq!(
        emails.iter().filter(|e| e.is_primary).count(),
        1,
        "exactly one is primary"
    );
    assert_eq!(emails[0].address, "work@example.com");
}

#[test]
fn the_primary_address_can_be_changed_and_the_identity_follows() {
    let (_dir, vault) = common::unlocked_vault();
    let identity = vault
        .create_identity("Me", Some("work@example.com"))
        .expect("create");
    let second = vault
        .add_identity_email(identity.id, "personal@example.com", false)
        .expect("second");

    vault
        .set_primary_email(identity.id, second.id)
        .expect("promote");

    let reloaded = vault
        .list_identities()
        .expect("identities")
        .into_iter()
        .find(|i| i.id == identity.id)
        .expect("still there");
    assert_eq!(
        reloaded.email.as_deref(),
        Some("personal@example.com"),
        "the identity shows the address that was promoted"
    );
}

#[test]
fn the_same_address_cannot_belong_to_two_identities() {
    // Otherwise one person's accounts split across two half-populated maps and
    // nothing ever reconciles them again.
    let (_dir, vault) = common::unlocked_vault();
    vault
        .create_identity("First", Some("shared@example.com"))
        .expect("first");
    let second = vault.create_identity("Second", None).expect("second");

    let err = vault
        .add_identity_email(second.id, "shared@example.com", false)
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::Invalid(m) if m.contains("another identity")),
        "got {err:?}"
    );
}

#[test]
fn addresses_are_matched_regardless_of_how_they_were_typed() {
    let (_dir, vault) = common::unlocked_vault();
    vault
        .create_identity("First", Some("Dev@Example.COM"))
        .expect("first");
    let second = vault.create_identity("Second", None).expect("second");

    let err = vault
        .add_identity_email(second.id, "  dev@example.com  ", false)
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "got {err:?}");
}

// ------------------------------------------------------------------ accounts

#[test]
fn any_service_can_be_recorded_even_one_devledger_has_never_heard_of() {
    let (_dir, vault) = common::unlocked_vault();
    let identity = vault
        .create_identity("Me", Some("me@example.com"))
        .expect("identity");

    let account = vault
        .create_account(&NewAccount {
            identity_id: identity.id,
            service: "Loopia".into(),
            label: "Domain registrar".into(),
            login_email: Some("billing@example.com".into()),
            username: Some("acme-admin".into()),
            url: Some("https://customerzone.loopia.se".into()),
            notes: Some("Two-factor by SMS".into()),
        })
        .expect("create");

    assert_eq!(account.provider, Provider::Other("Loopia".into()));
    assert_eq!(account.provider.label(), "Loopia");
    assert_eq!(account.username.as_deref(), Some("acme-admin"));
    assert_eq!(
        account.login_email.as_deref(),
        Some("billing@example.com"),
        "an account can sign in with an address other than the identity's own"
    );
}

#[test]
fn a_custom_service_survives_a_lock_and_unlock() {
    // The provider encoding is part of the on-disk format, so a round trip
    // through SQLCipher is the test that matters.
    let (dir, mut vault) = common::unlocked_vault();
    let identity = vault
        .create_identity("Me", Some("me@example.com"))
        .expect("identity");
    vault
        .create_account(&NewAccount {
            identity_id: identity.id,
            service: "My NAS".into(),
            label: "Home server".into(),
            login_email: None,
            username: Some("root".into()),
            url: None,
            notes: None,
        })
        .expect("create");
    vault.lock();

    let mut reopened = Vault::new(dir.path());
    reopened
        .unlock(&SecretString::new(common::PASSPHRASE))
        .expect("unlock");
    let accounts = reopened
        .accounts_for_identity(identity.id)
        .expect("accounts");
    assert_eq!(accounts[0].provider, Provider::Other("My NAS".into()));
    assert_eq!(accounts[0].provider.label(), "My NAS");
}

#[test]
fn a_password_belongs_to_the_account_rather_than_to_a_project() {
    let (_dir, mut vault) = common::unlocked_vault();
    let (_identity, account_id) = person(&vault, "me@example.com", "Loopia", "Registrar");

    let record = vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    account_id: Some(account_id),
                    ..SecretOwner::default()
                },
                kind: SecretKind::Password,
                name: "Login password".into(),
                environment: Environment::Unknown,
                notes: None,
            },
            &SecretString::new("correct horse battery staple"),
        )
        .expect("store");

    assert_eq!(record.account_id, Some(account_id));
    assert!(record.project_id.is_none());
    assert_eq!(
        vault.reveal_secret(record.id).expect("reveal").expose(),
        "correct horse battery staple"
    );

    let listed = vault.account_secrets(account_id).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].secret.preview, record.preview);
    assert_ne!(
        listed[0].secret.preview, "correct horse battery staple",
        "a listing shows a mask, never the value"
    );
}

#[test]
fn a_secret_that_belongs_to_nothing_is_refused() {
    let (_dir, mut vault) = common::unlocked_vault();
    let err = vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner::default(),
                kind: SecretKind::GenericApiKey,
                name: "STRAY".into(),
                environment: Environment::Unknown,
                notes: None,
            },
            &SecretString::new("value"),
        )
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)), "got {err:?}");
}

// ------------------------- the case the whole model exists for ---------------

#[test]
fn one_project_can_use_resources_from_two_accounts_at_the_same_provider() {
    let (_dir, mut vault) = common::unlocked_vault();

    // Two addresses, two Supabase accounts, one under each.
    let (identity_a, account_a) = person(&vault, "work@example.com", "Supabase", "Supabase (work)");
    let (identity_b, account_b) = person(
        &vault,
        "personal@example.com",
        "Supabase",
        "Supabase (personal)",
    );
    assert_ne!(identity_a, identity_b);
    assert_ne!(account_a, account_b);

    let api = resource(&vault, account_a, "storefront-api", Environment::Production);
    let stats_db = resource(
        &vault,
        account_b,
        "storefront-stats",
        Environment::Production,
    );

    // One DevLedger project draws on both.
    let project = vault.create_project("Storefront", None).expect("project");
    vault.link_service_project(api, project.id).expect("link a");
    vault
        .link_service_project(stats_db, project.id)
        .expect("link b");

    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    service_project_id: Some(api),
                    project_id: Some(project.id),
                    ..SecretOwner::default()
                },
                kind: SecretKind::SupabaseServiceRoleKey,
                name: "API_SERVICE_KEY".into(),
                environment: Environment::Production,
                notes: None,
            },
            &SecretString::new("service-key-from-work-account"),
        )
        .expect("store api key");
    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    service_project_id: Some(stats_db),
                    project_id: Some(project.id),
                    ..SecretOwner::default()
                },
                kind: SecretKind::SupabaseServiceRoleKey,
                name: "STATS_SERVICE_KEY".into(),
                environment: Environment::Production,
                notes: None,
            },
            &SecretString::new("service-key-from-personal-account"),
        )
        .expect("store stats key");

    let secrets = vault.list_secrets(project.id).expect("secrets");
    assert_eq!(
        secrets.len(),
        2,
        "the project reaches both accounts' credentials"
    );

    // And the two accounts stay apart: neither resource drifted onto the other.
    let resources = vault
        .service_projects_for_project(project.id)
        .expect("resources");
    assert_eq!(resources.len(), 2);
    let owning: Vec<_> = resources.iter().map(|r| r.account_id).collect();
    assert!(owning.contains(&account_a) && owning.contains(&account_b));
}

#[test]
fn the_overview_shows_the_chain_from_each_address_down_to_the_projects() {
    let (_dir, mut vault) = common::unlocked_vault();
    let (identity_a, account_a) = person(&vault, "work@example.com", "Supabase", "Supabase (work)");
    let (_identity_b, account_b) = person(
        &vault,
        "personal@example.com",
        "Supabase",
        "Supabase (personal)",
    );
    vault
        .add_identity_email(identity_a, "work-alias@example.com", false)
        .expect("alias");

    let api = resource(&vault, account_a, "storefront-api", Environment::Production);
    let stats = resource(
        &vault,
        account_b,
        "storefront-stats",
        Environment::Production,
    );
    let project = vault.create_project("Storefront", None).expect("project");
    vault.link_service_project(api, project.id).expect("link");
    vault.link_service_project(stats, project.id).expect("link");

    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    account_id: Some(account_a),
                    ..SecretOwner::default()
                },
                kind: SecretKind::Password,
                name: "Login".into(),
                environment: Environment::Unknown,
                notes: None,
            },
            &SecretString::new("pw"),
        )
        .expect("store");

    let overview = vault.overview().expect("overview");
    assert_eq!(overview.len(), 2, "one row per person");

    let work = overview
        .iter()
        .find(|o| o.identity.id == identity_a)
        .expect("work identity");
    assert_eq!(work.emails.len(), 2, "both of their addresses are shown");
    assert_eq!(
        work.projects
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Storefront"],
        "and the project their account reaches"
    );
    assert_eq!(work.secret_count, 1, "including the account's own password");

    // The same project is reachable from the other person too, which is the
    // point: the project does not belong to one address.
    let personal = overview
        .iter()
        .find(|o| o.identity.id != identity_a)
        .expect("personal identity");
    assert_eq!(
        personal
            .projects
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Storefront"]
    );
}

#[test]
fn two_accounts_at_one_provider_under_one_identity_are_flagged_not_merged() {
    let (_dir, vault) = common::unlocked_vault();
    let identity = vault
        .create_identity("Me", Some("me@example.com"))
        .expect("identity");
    for label in ["Supabase (main)", "Supabase (client work)"] {
        vault
            .create_account(&NewAccount {
                identity_id: identity.id,
                service: "Supabase".into(),
                label: label.into(),
                login_email: None,
                username: None,
                url: None,
                notes: None,
            })
            .expect("create");
    }

    let accounts = vault.accounts_for_identity(identity.id).expect("accounts");
    assert_eq!(accounts.len(), 2, "both are kept");

    let attention = vault.needs_attention().expect("attention");
    assert!(
        attention
            .iter()
            .any(|i| i.kind == AttentionKind::AmbiguousProviderAccount),
        "the ambiguity is surfaced rather than resolved behind the user's back"
    );
}

// ---------------------------------------------------- environments and .env

#[test]
fn the_same_variable_name_can_exist_once_per_environment() {
    let (_dir, mut vault) = common::unlocked_vault();
    let (_identity, account_id) = person(&vault, "me@example.com", "Supabase", "Supabase");
    let res = resource(&vault, account_id, "db", Environment::Unknown);
    let project = vault.create_project("Storefront", None).expect("project");
    vault.link_service_project(res, project.id).expect("link");

    for (env, value) in [
        (Environment::Development, "postgres://localhost/dev"),
        (Environment::Production, "postgres://prod.example.com/app"),
    ] {
        vault
            .store_secret(
                &NewSecret {
                    owner: SecretOwner {
                        project_id: Some(project.id),
                        ..SecretOwner::default()
                    },
                    kind: SecretKind::PostgresConnectionString,
                    name: "DATABASE_URL".into(),
                    environment: env,
                    notes: None,
                },
                &SecretString::new(value),
            )
            .unwrap_or_else(|e| panic!("store {env:?}: {e}"));
    }

    let environments = vault.project_environments(project.id).expect("envs");
    assert_eq!(
        environments,
        vec![Environment::Development, Environment::Production]
    );
}

#[test]
fn exporting_every_environment_at_once_is_refused_rather_than_silently_merged() {
    // A `.env` file is a flat namespace: a repeated key resolves to whichever
    // line comes last. Exporting both environments would therefore hand over a
    // production connection string under the impression it was the development
    // one. That is the failure this refusal exists to prevent.
    let (_dir, mut vault) = common::unlocked_vault();
    let project = vault.create_project("Storefront", None).expect("project");
    for (env, value) in [
        (Environment::Development, "postgres://localhost/dev"),
        (Environment::Production, "postgres://prod.example.com/app"),
    ] {
        vault
            .store_secret(
                &NewSecret {
                    owner: SecretOwner {
                        project_id: Some(project.id),
                        ..SecretOwner::default()
                    },
                    kind: SecretKind::PostgresConnectionString,
                    name: "DATABASE_URL".into(),
                    environment: env,
                    notes: None,
                },
                &SecretString::new(value),
            )
            .expect("store");
    }

    let err = vault.export_env(project.id, None).unwrap_err();
    let message = match &err {
        CoreError::Invalid(m) => m.clone(),
        other => panic!("expected a refusal, got {other:?}"),
    };
    assert!(
        message.contains("DATABASE_URL"),
        "names the variable: {message}"
    );
    assert!(message.contains("development") && message.contains("production"));
    assert!(
        !message.contains("postgres://"),
        "and never quotes a value: {message}"
    );

    let conflicts = vault.env_conflicts(project.id, None).expect("conflicts");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].definitions.len(), 2);
}

#[test]
fn exporting_one_environment_gives_exactly_that_environment() {
    let (_dir, mut vault) = common::unlocked_vault();
    let project = vault.create_project("Storefront", None).expect("project");
    for (env, name, value) in [
        (
            Environment::Development,
            "DATABASE_URL",
            "postgres://localhost/dev",
        ),
        (
            Environment::Production,
            "DATABASE_URL",
            "postgres://prod.example.com/app",
        ),
        (
            Environment::Production,
            "STRIPE_SECRET_KEY",
            "sk_live_example",
        ),
    ] {
        vault
            .store_secret(
                &NewSecret {
                    owner: SecretOwner {
                        project_id: Some(project.id),
                        ..SecretOwner::default()
                    },
                    kind: SecretKind::EnvVar,
                    name: name.into(),
                    environment: env,
                    notes: None,
                },
                &SecretString::new(value),
            )
            .expect("store");
    }

    let dev = vault
        .export_env(project.id, Some(Environment::Development))
        .expect("development export");
    assert_eq!(dev.expose().trim(), "DATABASE_URL=postgres://localhost/dev");
    assert!(
        !dev.expose().contains("prod.example.com"),
        "the production value must not appear in a development export"
    );

    let prod = vault
        .export_env(project.id, Some(Environment::Production))
        .expect("production export");
    assert!(prod.expose().contains("postgres://prod.example.com/app"));
    assert!(prod.expose().contains("sk_live_example"));
    assert!(!prod.expose().contains("localhost"));
}

// ------------------------------------------------------ editing and deleting

#[test]
fn editing_a_resource_does_not_disturb_what_points_at_it() {
    let (_dir, mut vault) = common::unlocked_vault();
    let (_identity, account_id) = person(&vault, "me@example.com", "Supabase", "Supabase");
    let res = resource(&vault, account_id, "old-name", Environment::Unknown);
    let project = vault.create_project("Storefront", None).expect("project");
    vault.link_service_project(res, project.id).expect("link");
    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    service_project_id: Some(res),
                    ..SecretOwner::default()
                },
                kind: SecretKind::GenericApiKey,
                name: "API_KEY".into(),
                environment: Environment::Production,
                notes: None,
            },
            &SecretString::new("value"),
        )
        .expect("store");

    vault
        .update_resource(
            res,
            &ResourceEdit {
                name: "new-name".into(),
                provider_ref: Some("ref-123".into()),
                region: Some("eu-north-1".into()),
                environment: Environment::Production,
                url: Some("https://example.com".into()),
                notes: Some("renamed".into()),
            },
        )
        .expect("update");

    let resources = vault
        .service_projects_for_project(project.id)
        .expect("resources");
    assert_eq!(resources.len(), 1, "still linked to the project");
    assert_eq!(resources[0].name, "new-name");
    assert_eq!(resources[0].provider_ref.as_deref(), Some("ref-123"));
    assert_eq!(
        vault.list_secrets(project.id).expect("secrets").len(),
        1,
        "and its secret is still reachable"
    );
}

#[test]
fn deleting_a_project_says_how_many_secrets_go_with_it() {
    let (_dir, mut vault) = common::unlocked_vault();
    let project = vault.create_project("Storefront", None).expect("project");
    for name in ["A", "B", "C"] {
        vault
            .store_secret(
                &NewSecret {
                    owner: SecretOwner {
                        project_id: Some(project.id),
                        ..SecretOwner::default()
                    },
                    kind: SecretKind::EnvVar,
                    name: name.into(),
                    environment: Environment::Unknown,
                    notes: None,
                },
                &SecretString::new("v"),
            )
            .expect("store");
    }

    let impact = vault.project_deletion_impact(project.id).expect("impact");
    assert_eq!(
        impact.secrets_deleted, 3,
        "the count is available before the delete, not discovered after it"
    );
}

#[test]
fn deleting_an_account_takes_its_own_secrets_and_leaves_other_accounts_alone() {
    let (_dir, mut vault) = common::unlocked_vault();
    let (_a, account_a) = person(&vault, "work@example.com", "Supabase", "Work");
    let (_b, account_b) = person(&vault, "personal@example.com", "Supabase", "Personal");
    for account in [account_a, account_b] {
        vault
            .store_secret(
                &NewSecret {
                    owner: SecretOwner {
                        account_id: Some(account),
                        ..SecretOwner::default()
                    },
                    kind: SecretKind::Password,
                    name: "Login".into(),
                    environment: Environment::Unknown,
                    notes: None,
                },
                &SecretString::new("pw"),
            )
            .expect("store");
    }

    vault.delete_account(account_a).expect("delete");

    assert!(vault.account(account_a).expect("lookup").is_none());
    assert_eq!(
        vault.account_secrets(account_b).expect("other").len(),
        1,
        "the other account is untouched"
    );
}
