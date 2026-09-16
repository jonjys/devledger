//! M1: the secure foundation.
//!
//! These tests pin the properties the rest of DevLedger is allowed to assume:
//! secrets do not leak through formatting, key derivation is deterministic and
//! salt-dependent, the AEAD rejects every form of tampering, subkeys are
//! independent, and blind indexes are stable within a vault and useless across
//! vaults.

mod common;

use devledger_core::crypto::blind_index::{self, DOMAIN_SECRET_VALUE};
use devledger_core::crypto::kdf::{self, KdfParams};
use devledger_core::crypto::{
    aead, derive_subkey, LABEL_BLIND_INDEX, LABEL_DATABASE, LABEL_SECRET_AEAD,
};
use devledger_core::model::SecretKind;
use devledger_core::redact::{self, SecretSpan, SourceKind};
use devledger_core::secret::{mask_preview, SecretBytes, SecretString};

fn key(byte: u8) -> SecretBytes {
    SecretBytes::new(vec![byte; 32])
}

#[test]
fn secret_string_debug_never_prints_the_value() {
    let secret = SecretString::new("super-secret-value");
    let rendered = format!("{secret:?}");
    assert_eq!(rendered, "SecretString(<redacted>)");
    assert!(!rendered.contains("super-secret-value"));
}

#[test]
fn secret_bytes_debug_reports_length_but_not_content() {
    let bytes = SecretBytes::new(vec![0xAB; 32]);
    let rendered = format!("{bytes:?}");
    assert_eq!(rendered, "SecretBytes(<redacted, 32 bytes>)");
    assert!(!rendered.contains("ab"));
}

#[test]
fn mask_preview_never_reveals_most_of_a_secret() {
    // A short secret must not be substantially readable from its preview.
    for value in ["abc", "abcdef", "abcdefghi", "hunter2-hunter2"] {
        let preview = mask_preview(value);
        let revealed: usize = preview.chars().filter(|c| *c != '…' && *c != '•').count();
        assert!(
            revealed * 3 <= value.chars().count() + 2,
            "preview {preview:?} reveals too much of {value:?}"
        );
    }
    // A long key shows a recognisable head and tail.
    let long = "sb_secret_0123456789abcdefghijklmnop";
    assert_eq!(mask_preview(long), "sb_s…mnop");
}

#[test]
fn kdf_is_deterministic_for_the_same_passphrase_and_salt() {
    let params = KdfParams::weak_for_tests().expect("params");
    let pass = SecretString::new(common::PASSPHRASE);
    let a = kdf::derive_master_key(&pass, &params).expect("derive");
    let b = kdf::derive_master_key(&pass, &params).expect("derive");
    assert_eq!(a.expose(), b.expose());
    assert_eq!(a.len(), 32);
}

#[test]
fn kdf_output_depends_on_both_salt_and_passphrase() {
    let pass = SecretString::new(common::PASSPHRASE);
    let params_a = KdfParams::weak_for_tests().expect("params");
    let params_b = KdfParams::weak_for_tests().expect("params");
    assert_ne!(params_a.salt_hex, params_b.salt_hex, "salts must be random");

    let same_pass_other_salt = kdf::derive_master_key(&pass, &params_b).expect("derive");
    let base = kdf::derive_master_key(&pass, &params_a).expect("derive");
    assert_ne!(base.expose(), same_pass_other_salt.expose());

    let other_pass =
        kdf::derive_master_key(&SecretString::new("a-completely-different-one"), &params_a)
            .expect("derive");
    assert_ne!(base.expose(), other_pass.expose());
}

#[test]
fn kdf_rejects_an_empty_passphrase() {
    let params = KdfParams::weak_for_tests().expect("params");
    let err = kdf::derive_master_key(&SecretString::new(""), &params).unwrap_err();
    assert!(matches!(err, devledger_core::CoreError::Invalid(_)));
}

#[test]
fn aead_round_trips() {
    let k = key(1);
    let envelope = aead::seal(&k, b"SUPABASE_KEY", b"the-plaintext").expect("seal");
    assert!(!envelope.windows(13).any(|w| w == b"the-plaintext"));

    let opened = aead::open(&k, b"SUPABASE_KEY", &envelope).expect("open");
    assert_eq!(opened.expose(), b"the-plaintext");
}

#[test]
fn aead_rejects_a_tampered_ciphertext() {
    let k = key(2);
    let mut envelope = aead::seal(&k, b"aad", b"plaintext").expect("seal");
    let last = envelope.len() - 1;
    envelope[last] ^= 0x01;
    assert!(aead::open(&k, b"aad", &envelope).is_err());
}

#[test]
fn aead_rejects_the_wrong_associated_data() {
    let k = key(3);
    let envelope = aead::seal(&k, b"SECRET_A", b"plaintext").expect("seal");
    // This is what stops a ciphertext being moved onto another secret's row.
    assert!(aead::open(&k, b"SECRET_B", &envelope).is_err());
}

#[test]
fn aead_rejects_the_wrong_key() {
    let envelope = aead::seal(&key(4), b"aad", b"plaintext").expect("seal");
    assert!(aead::open(&key(5), b"aad", &envelope).is_err());
}

#[test]
fn aead_rejects_a_truncated_envelope() {
    let k = key(6);
    let envelope = aead::seal(&k, b"aad", b"plaintext").expect("seal");
    assert!(aead::open(&k, b"aad", &envelope[..10]).is_err());
}

#[test]
fn aead_nonce_is_fresh_for_every_seal() {
    let k = key(7);
    let a = aead::seal(&k, b"aad", b"same-plaintext").expect("seal");
    let b = aead::seal(&k, b"aad", b"same-plaintext").expect("seal");
    assert_ne!(
        a, b,
        "identical plaintexts must not produce identical envelopes"
    );
}

#[test]
fn subkeys_are_independent_of_each_other() {
    let master = key(9);
    let db = derive_subkey(&master, LABEL_DATABASE).expect("subkey");
    let seal = derive_subkey(&master, LABEL_SECRET_AEAD).expect("subkey");
    let index = derive_subkey(&master, LABEL_BLIND_INDEX).expect("subkey");

    assert_ne!(db.expose(), seal.expose());
    assert_ne!(db.expose(), index.expose());
    assert_ne!(seal.expose(), index.expose());
    // And none of them is the master itself.
    assert_ne!(db.expose(), master.expose());

    // Derivation is deterministic.
    assert_eq!(
        db.expose(),
        derive_subkey(&master, LABEL_DATABASE)
            .expect("subkey")
            .expose()
    );
}

#[test]
fn blind_index_is_stable_and_normalises_wrapping() {
    let k = key(11);
    let plain = blind_index::blind_index(&k, DOMAIN_SECRET_VALUE, "sb_secret_abc").expect("index");
    let quoted =
        blind_index::blind_index(&k, DOMAIN_SECRET_VALUE, "  \"sb_secret_abc\"  ").expect("index");
    assert_eq!(
        plain, quoted,
        "quoting and padding must not change the index"
    );

    // Case is significant: API keys are case-sensitive.
    let other = blind_index::blind_index(&k, DOMAIN_SECRET_VALUE, "SB_SECRET_ABC").expect("index");
    assert_ne!(plain, other);

    // 16 bytes rendered as hex.
    assert_eq!(plain.len(), 32);
}

#[test]
fn blind_index_is_useless_across_vaults_and_domains() {
    let value = "sb_secret_abc";
    let vault_a = blind_index::blind_index(&key(12), DOMAIN_SECRET_VALUE, value).expect("index");
    let vault_b = blind_index::blind_index(&key(13), DOMAIN_SECRET_VALUE, value).expect("index");
    assert_ne!(
        vault_a, vault_b,
        "a stolen index must not transfer between vaults"
    );

    let other_domain =
        blind_index::blind_index(&key(12), "some-other-domain", value).expect("index");
    assert_ne!(vault_a, other_domain, "domains must be separated");
}

#[test]
fn redaction_removes_every_flagged_span() {
    let text = "SUPABASE_SERVICE_ROLE_KEY=sb_secret_supersecretvalue";
    let start = text.find("sb_secret").expect("present");
    let spans = vec![SecretSpan {
        start,
        end: text.len(),
        kind: SecretKind::SupabaseServiceRoleKey,
    }];
    let out = redact::redact(text, &spans);
    assert!(!out.contains("supersecretvalue"));
    assert!(out.contains("[REDACTED:SUPABASE_SERVICE_ROLE_KEY]"));
    assert!(out.starts_with("SUPABASE_SERVICE_ROLE_KEY="));
}

#[test]
fn sweep_catches_credentials_no_detector_claimed() {
    // Nothing is passed as a span: this is purely the safety net.
    let text =
        "token ghp_0123456789abcdefghij0123456789abcdefgh and sk-abcdefghijklmnopqrstuvwxyz0123";
    let out = redact::sweep(text);
    assert!(!out.contains("ghp_0123456789abcdefghij"));
    assert!(!out.contains("sk-abcdefghijklmnopqrstuvwxyz"));
    assert!(out.contains("[REDACTED:GITHUB_TOKEN]"));
    assert!(out.contains("[REDACTED:OPENAI_API_KEY]"));
}

#[test]
fn sweep_strips_passwords_out_of_connection_urls() {
    let text = "postgresql://postgres.abcdefghijklmnopqrst:hunter2@db.example.com:5432/postgres";
    let out = redact::sweep(text);
    assert!(!out.contains("hunter2"));
    assert!(out.contains("[REDACTED:PASSWORD]"));
    // The non-secret shape of the URL survives, which is the point of provenance.
    assert!(out.contains("db.example.com"));
}

#[test]
fn provenance_excerpt_contains_no_secret_and_records_original_length() {
    let text = common::SUPABASE_ENV;
    let provenance = redact::provenance(text, &[], SourceKind::SmartPaste);

    assert!(!provenance
        .redacted_excerpt
        .contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
    assert!(!provenance.redacted_excerpt.contains("s3cr3t-pw"));
    assert_eq!(provenance.original_len, text.chars().count());
    assert_eq!(provenance.source, SourceKind::SmartPaste);
}
