//! Schema definition and migrations.
//!
//! Migrations are append-only: each entry is applied once, in order, inside a
//! transaction, and `schema_version` records how far the database has got.

/// The schema version this build expects.
pub const CURRENT_VERSION: i64 = 2;

/// Ordered migration steps. Index `n` upgrades the database to version `n + 1`.
pub const MIGRATIONS: &[&str] = &[V1, V2];

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

/// v2 separates a DevLedger project from the provider resources it uses.
///
/// v1 collapsed the two: a `projects` row *was* a Supabase project. That made
/// it impossible to record that one DevLedger project draws on a Supabase
/// project, a Vercel project and a Stripe account at once, or that one
/// developer holds several Supabase accounts and organizations. v2 splits them:
///
/// ```text
/// identity -> account -> organization? -> service_project -> project
/// ```
///
/// The organization link is nullable on purpose. When a paste does not say
/// which organization a resource belongs to, the resource is left unassigned
/// and surfaced under Needs attention, rather than filed under an invented name.
///
/// Existing data is carried across: each v1 project becomes a `service_projects`
/// row plus a DevLedger `projects` row of the same name, linked by `used_by`.
/// Organizations v1 auto-created (named `Personal` with no provider id) are
/// dropped and their resources left unassigned, because that name was never
/// evidence of anything.
const V2: &str = r#"
ALTER TABLE projects RENAME TO projects_v1;
DROP INDEX IF EXISTS idx_projects_ref;
DROP INDEX IF EXISTS idx_projects_org;

CREATE TABLE service_projects (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES organizations (id) ON DELETE SET NULL,
    provider        TEXT NOT NULL,
    provider_ref    TEXT,
    name            TEXT NOT NULL,
    region          TEXT,
    environment     TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_service_projects_ref
    ON service_projects (provider, provider_ref)
    WHERE provider_ref IS NOT NULL;
CREATE INDEX idx_service_projects_account ON service_projects (account_id);
CREATE INDEX idx_service_projects_org ON service_projects (organization_id);

CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_projects_name ON projects (name COLLATE NOCASE);

INSERT INTO service_projects
    (id, account_id, organization_id, provider, provider_ref, name, region,
     environment, created_at)
SELECT p.id, o.account_id, p.organization_id, 'supabase', p.provider_project_ref,
       p.name, p.region, p.environment, p.created_at
FROM projects_v1 p
JOIN organizations o ON o.id = p.organization_id;

INSERT INTO projects (id, name, description, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
       || substr(lower(hex(randomblob(2))), 2) || '-a'
       || substr(lower(hex(randomblob(2))), 2) || '-'
       || lower(hex(randomblob(6))),
       sp.name, 'Migrated from DevLedger 0.3.0', sp.created_at
FROM service_projects sp;

CREATE TABLE secrets_v2 (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT REFERENCES projects (id) ON DELETE CASCADE,
    service_project_id TEXT REFERENCES service_projects (id) ON DELETE CASCADE,
    kind               TEXT NOT NULL,
    name               TEXT NOT NULL,
    preview            TEXT NOT NULL,
    value_blind_index  TEXT NOT NULL,
    environment        TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    CHECK (project_id IS NOT NULL OR service_project_id IS NOT NULL)
);

INSERT INTO secrets_v2
    (id, project_id, service_project_id, kind, name, preview,
     value_blind_index, environment, created_at, updated_at)
SELECT s.id, NULL, s.project_id, s.kind, s.name, s.preview,
       s.value_blind_index, s.environment, s.created_at, s.updated_at
FROM secrets s;

DROP TABLE secrets;
ALTER TABLE secrets_v2 RENAME TO secrets;
CREATE INDEX idx_secrets_blind_index ON secrets (value_blind_index);
CREATE INDEX idx_secrets_project ON secrets (project_id);
CREATE INDEX idx_secrets_service_project ON secrets (service_project_id);
CREATE UNIQUE INDEX idx_secrets_unique_name
    ON secrets (COALESCE(project_id, ''), COALESCE(service_project_id, ''), name);

INSERT OR IGNORE INTO relations
    (id, from_kind, from_id, to_kind, to_id, kind,
     evidence_level, evidence_rule, evidence_reason, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
       || substr(lower(hex(randomblob(2))), 2) || '-a'
       || substr(lower(hex(randomblob(2))), 2) || '-'
       || lower(hex(randomblob(6))),
       'service_project', sp.id, 'project', p.id, 'used_by',
       'heuristic', 'migration.v2',
       'Carried over from a DevLedger 0.3.0 vault, where the two were one row',
       sp.created_at
FROM service_projects sp
JOIN projects p ON p.name = sp.name;

DROP TABLE projects_v1;

UPDATE service_projects
   SET organization_id = NULL
 WHERE organization_id IN (
    SELECT id FROM organizations WHERE name = 'Personal' AND provider_org_id IS NULL
 );
DELETE FROM organizations WHERE name = 'Personal' AND provider_org_id IS NULL;

ALTER TABLE subscriptions ADD COLUMN trial_ends_at TEXT;
"#;
