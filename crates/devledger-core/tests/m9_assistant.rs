//! The AI assistant's outline: what leaves the machine, and what never does.
//!
//! The promise is simple to state and easy to break by accident: no key value,
//! no masked preview of one, no email address, no free-text note. These tests
//! build a vault that holds all of those and check the outline for each.

mod common;

use devledger_core::assistant::{Task, MAX_QUESTION, SYSTEM_PROMPT};
use devledger_core::manual::NewSecret;
use devledger_core::model::{EntityKind, EntityRef, Environment, Provider, SecretKind};
use devledger_core::secret::SecretString;
use devledger_core::store::{AccountDetails, SecretOwner};
use devledger_core::{CoreError, Vault};

const STRIPE_VALUE: &str = concat!("sk_", "live_", "FAKE0000DEMO1111TEST2222NOTREAL33");
const DB_VALUE: &str = "postgres://admin:hunter2-very-secret@db.internal.example.com:5432/app";

struct Fixture {
    stripe_key: uuid::Uuid,
}

fn fill(vault: &mut Vault) -> Fixture {
    let me = vault
        .create_identity_manual("Fredrik", Some("me@personal.example"))
        .expect("identity");
    vault
        .add_identity_email(me.id, "work@company.example", false)
        .expect("second address");
    let stripe = vault
        .create_account_with_details(
            me.id,
            Provider::Stripe,
            "billing@company.example",
            &AccountDetails {
                login_email: Some("billing@company.example".into()),
                notes: Some("recovery code 1234-5678 is in the drawer".into()),
                ..AccountDetails::default()
            },
        )
        .expect("stripe account");
    let resource = vault
        .create_service_project_manual(
            stripe.id,
            None,
            Provider::Stripe,
            "Shop payments",
            None,
            Environment::Production,
        )
        .expect("resource");
    let project = vault
        .create_project("Shop", Some("The web shop"))
        .expect("project");
    vault
        .link_service_project(resource.id, project.id)
        .expect("link");
    let stripe_key = vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    project_id: None,
                    service_project_id: Some(resource.id),
                    account_id: None,
                },
                kind: SecretKind::StripeSecretKey,
                name: "STRIPE_SECRET_KEY".into(),
                environment: Environment::Production,
                notes: Some("rotated after the March incident, old one was sk_live_OLD".into()),
            },
            &SecretString::new(STRIPE_VALUE),
        )
        .expect("stripe secret")
        .id;
    vault
        .store_secret(
            &NewSecret {
                owner: SecretOwner {
                    project_id: Some(project.id),
                    service_project_id: None,
                    account_id: None,
                },
                kind: SecretKind::PostgresConnectionString,
                name: "DATABASE_URL".into(),
                environment: Environment::Production,
                notes: None,
            },
            &SecretString::new(DB_VALUE),
        )
        .expect("db secret");
    vault
        .add_custom_field(
            &EntityRef::new(EntityKind::Account, stripe.id),
            "Support PIN",
            "8842",
        )
        .expect("field");
    Fixture { stripe_key }
}

fn previews(vault: &Vault) -> Vec<String> {
    vault
        .list_all_secrets()
        .expect("secrets")
        .into_iter()
        .map(|l| l.entry.secret.preview)
        .collect()
}

#[test]
fn the_outline_carries_no_key_value_preview_note_or_address() {
    let (_dir, mut vault) = common::unlocked_vault();
    fill(&mut vault);
    let prepared = vault
        .assistant_prepare(&Task::Review, "sv-SE")
        .expect("prepare");
    let sent = format!("{}\n{}", prepared.system, prepared.user);

    for needle in [
        STRIPE_VALUE,
        DB_VALUE,
        "hunter2",
        "sk_live_",
        "drawer",
        "1234-5678",
        "8842",
        "Support PIN",
    ] {
        assert!(!sent.contains(needle), "the outline leaked {needle:?}");
    }
    for preview in previews(&vault) {
        assert!(
            !sent.contains(&preview),
            "the outline leaked the preview {preview:?}"
        );
    }
    for address in [
        "me@personal.example",
        "work@company.example",
        "billing@company.example",
    ] {
        assert!(
            !sent.contains(address),
            "the outline leaked the address {address}"
        );
    }

    // What it does say: names, kinds, relationships, and the language to answer in.
    assert!(sent.contains("STRIPE_SECRET_KEY"));
    assert!(sent.contains("Shop payments"));
    assert!(sent.contains("used by \"Shop\""));
    assert!(sent.contains("<email-1>"));
    assert!(sent.contains("Answer in Swedish."));
    assert_eq!(
        prepared.system, SYSTEM_PROMPT,
        "the instructions never vary, so they can be cached"
    );
}

#[test]
fn the_real_addresses_come_back_in_the_answer() {
    let (_dir, mut vault) = common::unlocked_vault();
    fill(&mut vault);
    let prepared = vault
        .assistant_prepare(&Task::Review, "en")
        .expect("prepare");
    assert!(prepared.placeholder_count() >= 3);

    let answer = "Move production off <email-1> and onto <email-2>.";
    let restored = prepared.restore(answer);
    assert!(!restored.contains("<email-"));
    assert!(restored.contains('@'));
}

#[test]
fn a_leak_plan_names_the_key_and_refuses_an_unknown_one() {
    let (_dir, mut vault) = common::unlocked_vault();
    let f = fill(&mut vault);
    let prepared = vault
        .assistant_prepare(
            &Task::Leak {
                secret_id: f.stripe_key,
            },
            "en",
        )
        .expect("prepare");
    assert!(prepared.user.contains("has leaked"));
    assert!(prepared
        .user
        .contains("(STRIPE_SECRET_KEY, Stripe secret key)"));
    assert!(!prepared.user.contains(STRIPE_VALUE));

    let missing = vault.assistant_prepare(
        &Task::Leak {
            secret_id: uuid::Uuid::new_v4(),
        },
        "en",
    );
    assert!(matches!(missing, Err(CoreError::NotFound(_))));
}

#[test]
fn a_question_is_swept_before_it_is_sent() {
    let (_dir, mut vault) = common::unlocked_vault();
    fill(&mut vault);
    let prepared = vault
        .assistant_prepare(
            &Task::Ask {
                question: format!("Is this key still valid? STRIPE_SECRET_KEY={STRIPE_VALUE} — ask me@personal.example"),
            },
            "en",
        )
        .expect("prepare");
    assert!(
        !prepared.user.contains(STRIPE_VALUE),
        "a pasted key must not be sent"
    );
    assert!(!prepared.user.contains("me@personal.example"));

    let empty = vault.assistant_prepare(
        &Task::Ask {
            question: "   ".into(),
        },
        "en",
    );
    assert!(matches!(empty, Err(CoreError::Invalid(_))));
    let long = vault.assistant_prepare(
        &Task::Ask {
            question: "x".repeat(MAX_QUESTION + 1),
        },
        "en",
    );
    assert!(matches!(long, Err(CoreError::Invalid(_))));
}

#[test]
fn the_assistant_key_is_sealed_and_can_be_removed() {
    let (dir, vault) = common::unlocked_vault();
    assert!(!vault.assistant_enabled().unwrap());
    assert!(matches!(
        vault.set_assistant_key(&SecretString::new("not-a-key")),
        Err(CoreError::Invalid(_))
    ));

    let key = &format!("sk-ant-{}", "api03-test-key-not-real-0000000000");
    vault
        .set_assistant_key(&SecretString::new(format!("  {key}\n")))
        .expect("store");
    assert!(vault.assistant_enabled().unwrap());
    assert_eq!(vault.assistant_key().unwrap().expose(), key);

    // Sealed at rest: the database file never holds the key.
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap_or_default();
        assert!(
            !bytes.windows(key.len()).any(|w| w == key.as_bytes()),
            "the key was found in plaintext on disk"
        );
    }

    vault.clear_assistant_key().expect("clear");
    assert!(!vault.assistant_enabled().unwrap());
    assert!(matches!(vault.assistant_key(), Err(CoreError::NotFound(_))));
}
