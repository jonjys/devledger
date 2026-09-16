//! Schema definition and migrations.
//!
//! Migrations are append-only: each entry is applied once, in order, inside a
//! transaction, and `schema_version` records how far the database has got.

/// The schema version this build expects.
pub const CURRENT_VERSION: i64 = 1;

/// Ordered migration steps. Index `n` upgrades the database to version `n + 1`.
pub const MIGRATIONS: &[&str] = &[V1];

const V1: &str = r#"
CREATE TABLE identities (
    id                TEXT PRIMARY KEY,
    label             TEXT NOT NULL,
    email             TEXT,
    email_blind_index TEXT,
    created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_identities_email_bi
    ON identities (email_blind_index)
    WHERE email_blind_index IS NOT NULL;

CREATE TABLE accounts (
    id           TEXT PRIMARY KEY,
    identity_id  TEXT NOT NULL REFERENCES identities (id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    external_ref TEXT,
    label        TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX idx_accounts_identity ON accounts (identity_id);

CREATE TABLE organizations (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    provider_org_id TEXT,
    name            TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_organizations_account ON organizations (account_id);

CREATE TABLE projects (
    id                   TEXT PRIMARY KEY,
    organization_id      TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    provider_project_ref TEXT,
    name                 TEXT NOT NULL,
    region               TEXT,
    environment          TEXT NOT NULL,
    created_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_projects_ref
    ON projects (provider_project_ref)
    WHERE provider_project_ref IS NOT NULL;
CREATE INDEX idx_projects_org ON projects (organization_id);

CREATE TABLE secrets (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    preview           TEXT NOT NULL,
    value_blind_index TEXT NOT NULL,
    environment       TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (project_id, name)
);
CREATE INDEX idx_secrets_blind_index ON secrets (value_blind_index);
CREATE INDEX idx_secrets_project ON secrets (project_id);

-- Ciphertext lives apart from metadata so that listing a vault never touches
-- an envelope, and a reveal is a distinct, auditable read.
CREATE TABLE secret_values (
    secret_id TEXT PRIMARY KEY REFERENCES secrets (id) ON DELETE CASCADE,
    envelope  BLOB NOT NULL
);

CREATE TABLE subscriptions (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    plan         TEXT NOT NULL,
    status       TEXT NOT NULL,
    amount_cents INTEGER,
    currency     TEXT,
    interval     TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_account ON subscriptions (account_id);

CREATE TABLE relations (
    id              TEXT PRIMARY KEY,
    from_kind       TEXT NOT NULL,
    from_id         TEXT NOT NULL,
    to_kind         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    kind            TEXT NOT NULL,
    evidence_level  TEXT NOT NULL,
    evidence_rule   TEXT NOT NULL,
    evidence_reason TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE (from_kind, from_id, to_kind, to_id, kind)
);
CREATE INDEX idx_relations_from ON relations (from_kind, from_id);
CREATE INDEX idx_relations_to ON relations (to_kind, to_id);

CREATE TABLE provenance_records (
    id               TEXT PRIMARY KEY,
    entity_kind      TEXT NOT NULL,
    entity_id        TEXT NOT NULL,
    source           TEXT NOT NULL,
    redacted_excerpt TEXT NOT NULL,
    original_len     INTEGER NOT NULL,
    captured_at      TEXT NOT NULL
);
CREATE INDEX idx_provenance_entity ON provenance_records (entity_kind, entity_id);

-- Append-only change log. Not event sourcing: the tables above are the source
-- of truth, this is the audit trail beside them.
CREATE TABLE audit_log (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity_kind TEXT,
    entity_id   TEXT,
    detail      TEXT NOT NULL
);
CREATE INDEX idx_audit_at ON audit_log (at);

CREATE TRIGGER audit_log_is_append_only_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_is_append_only_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;
"#;
