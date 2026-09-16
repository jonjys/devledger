#![allow(dead_code)] // each integration test binary uses a different subset

//! Shared helpers for the integration tests.

use devledger_core::crypto::kdf::KdfParams;
use devledger_core::secret::SecretString;
use devledger_core::Vault;
use tempfile::TempDir;

/// A test passphrase that satisfies the minimum-length rule.
pub const PASSPHRASE: &str = "correct-horse-battery-staple";

/// Create an unlocked vault in a temporary directory, using deliberately weak
/// KDF parameters so the suite is not dominated by Argon2id.
pub fn unlocked_vault() -> (TempDir, Vault) {
    let dir = TempDir::new().expect("temp dir");
    let mut vault = Vault::new(dir.path());
    vault
        .initialize_with_params(
            &SecretString::new(PASSPHRASE),
            KdfParams::weak_for_tests().expect("params"),
        )
        .expect("initialize");
    (dir, vault)
}

/// A realistic Supabase `.env` block. The JWTs are syntactically valid and
/// carry real-looking claims, but are unsigned junk: never valid credentials.
pub const SUPABASE_ENV: &str = r#"
NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAxNTU3NjAwMH0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDE1NTc2MDAwfQ.c2lnbmF0dXJlLXBsYWNlaG9sZGVy
DATABASE_URL=postgresql://postgres.abcdefghijklmnopqrst:s3cr3t-pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
"#;

/// A paste shaped like the ones DevLedger is actually for: a project name, an
/// organization name, the email that holds the account, the provider, and then
/// the credentials.
///
/// The names are deliberately generic test data. Nothing about them is special
/// to DevLedger; any developer's project and organization names would work the
/// same way.
pub const SUPABASE_FULL: &str = concat!(
    "Acme Storefront\n",
    "AcmeOrg\n",
    "dev-a@example.com\n",
    "Supabase\n",
    "https://abcdefghijklmnopqrst.supabase.co\n",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAxNTU3NjAwMH0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy\n",
    "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDE1NTc2MDAwfQ.c2lnbmF0dXJlLXBsYWNlaG9sZGVy\n",
    "DATABASE_URL=postgresql://postgres.abcdefghijklmnopqrst:s3cr3t-pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres\n",
);

/// A second developer identity, organization and Supabase project, so tests can
/// prove the two are kept apart rather than merged.
pub const SUPABASE_SECOND_ACCOUNT: &str = concat!(
    "Beta Dashboard\n",
    "BetaOrg\n",
    "dev-b@example.com\n",
    "Supabase\n",
    "https://zyxwvutsrqponmlkjihg.supabase.co\n",
    "BETA_SUPABASE_ANON_KEY=sb_publishable_betabetabetabeta\n",
);

/// Build a submission that accepts every recommendation and answers every open
/// question with its recommended candidate.
///
/// This mirrors what the review sheet sends when the user presses Save without
/// changing anything.
pub fn accept_all(
    analysis: &devledger_core::paste::PasteAnalysis,
) -> devledger_core::paste::ReviewSubmission {
    use devledger_core::paste::{
        AnswerChoice, EntityDecision, QuestionAnswer, ReviewDecision, ReviewSubmission,
    };

    let answers = analysis
        .questions
        .iter()
        .filter_map(|q| {
            let candidate = q
                .candidates
                .iter()
                .find(|c| c.recommended)
                .or_else(|| q.candidates.first())?;
            let choice = match &candidate.existing {
                Some(entity) => AnswerChoice::Existing {
                    entity: entity.clone(),
                },
                None => AnswerChoice::NewNamed {
                    name: candidate.label.clone(),
                },
            };
            Some(QuestionAnswer {
                question_id: q.id.clone(),
                choice,
            })
        })
        .collect();

    ReviewSubmission {
        analysis_id: analysis.analysis_id,
        decisions: (0..analysis.entities.len())
            .map(|entity_index| ReviewDecision {
                entity_index,
                decision: EntityDecision::Accept,
                name_override: None,
            })
            .collect(),
        accepted_relations: analysis
            .proposed_relations
            .iter()
            .filter(|r| r.selected_by_default)
            .map(|r| r.index)
            .collect(),
        acknowledge_critical: false,
        target_project_id: None,
        answers,
    }
}

/// Build a discovery snapshot the way a connector would return one.
pub fn discovery(
    orgs: &[(&str, &str)],
    projects: &[(&str, &str, &str)],
) -> devledger_core::connect::Discovery {
    use devledger_core::connect::{DiscoveredOrganization, DiscoveredProject, Discovery};
    use devledger_core::model::Provider;

    Discovery {
        provider: Provider::Supabase,
        organizations: orgs
            .iter()
            .map(|(id, name)| DiscoveredOrganization {
                provider_org_id: (*id).to_string(),
                name: (*name).to_string(),
            })
            .collect(),
        projects: projects
            .iter()
            .map(|(r, org, name)| DiscoveredProject {
                provider_ref: (*r).to_string(),
                provider_org_id: (*org).to_string(),
                name: (*name).to_string(),
                region: Some("eu-west-1".to_string()),
                status: Some("ACTIVE_HEALTHY".to_string()),
            })
            .collect(),
        account_email: None,
    }
}

/// A plausible-looking Supabase personal access token. Not a real credential.
pub const FAKE_TOKEN_A: &str = "sbp_0000000000000000000000000000000000000001";
/// A second one, for the second account.
pub const FAKE_TOKEN_B: &str = "sbp_0000000000000000000000000000000000000002";
