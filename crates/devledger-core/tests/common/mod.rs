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
