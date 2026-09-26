//! Schema definition and migrations.
//!
//! Migrations are append-only: each entry is applied once, in order, inside a
//! transaction, and `schema_version` records how far the database has got.
//!
//! # One amendment, and why it was allowed
//!
//! [`V2`] was corrected after release. Normally an applied migration is frozen,
//! because rewriting one changes history for databases that have already run
//! it. This one was safe to amend for exactly that reason: a vault past version
//! 2 never runs it again, so the edit can only affect a vault still at version
//! 1 — where the original would have refused to open it at all. See the
//! `two_v1_projects_sharing_a_name_do_not_block_the_upgrade` test.
//!
//! The other v1 defect — the upgrade destroying every sealed value — was fixed
//! in the migration *runner* rather than here, because it was a property of how
//! migrations were executed and would have recurred in any future rebuild of a
//! referenced table. A vault that was upgraded before that fix has lost its
//! ciphertext already; nothing here can bring it back, so
//! [`crate::store::AttentionKind::SecretValueMissing`] surfaces it instead of
//! letting it look like a working vault.

/// The schema version this build expects.
pub const CURRENT_VERSION: i64 = 4;

/// Ordered migration steps. Index `n` upgrades the database to version `n + 1`.
pub const MIGRATIONS: &[&str] = &[V1, V2, V3, V4];

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

-- One DevLedger project per v1 resource, mapped by id rather than by name.
--
-- v1 allowed two resources to share a name; v2's `projects` table does not.
-- Matching them up by name would both abort the migration on a collision and,
-- worse, risk linking a resource to a project it has nothing to do with. Two
-- rows that happen to share a name are not evidence that they are the same
-- project, so a collision disambiguates with the resource's own id instead of
-- merging.
CREATE TABLE v2_project_map (
    service_project_id TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    name               TEXT NOT NULL
);

INSERT INTO v2_project_map (service_project_id, project_id, name)
SELECT sp.id,
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
       || substr(lower(hex(randomblob(2))), 2) || '-a'
       || substr(lower(hex(randomblob(2))), 2) || '-'
       || lower(hex(randomblob(6))),
       CASE
           WHEN (SELECT count(*) FROM service_projects other
                  WHERE other.name = sp.name COLLATE NOCASE) > 1
               THEN sp.name || ' (' || substr(sp.id, 1, 8) || ')'
           ELSE sp.name
       END
FROM service_projects sp;

INSERT INTO projects (id, name, description, created_at)
SELECT m.project_id, m.name, 'Migrated from DevLedger 0.3.0', sp.created_at
FROM v2_project_map m
JOIN service_projects sp ON sp.id = m.service_project_id;

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
       'service_project', m.service_project_id, 'project', m.project_id, 'used_by',
       'heuristic', 'migration.v2',
       'Carried over from a DevLedger 0.3.0 vault, where the two were one row',
       sp.created_at
FROM v2_project_map m
JOIN service_projects sp ON sp.id = m.service_project_id;

DROP TABLE v2_project_map;
DROP TABLE projects_v1;

UPDATE service_projects
   SET organization_id = NULL
 WHERE organization_id IN (
    SELECT id FROM organizations WHERE name = 'Personal' AND provider_org_id IS NULL
 );
DELETE FROM organizations WHERE name = 'Personal' AND provider_org_id IS NULL;

ALTER TABLE subscriptions ADD COLUMN trial_ends_at TEXT;
"#;

/// v3 adds Connect & Discover.
///
/// A connection is one *connected provider account*, not one provider: someone
/// with three Supabase accounts gets three rows, each with its own credential,
/// its own identity and its own account in the graph. The unique index is on
/// `(connector_id, account_fingerprint)` so reconnecting the same account
/// refreshes it, while a genuinely different account always gets its own row.
///
/// The credential is stored as an AEAD envelope under the vault's secret key,
/// exactly like a secret value, and is never handed to the frontend.
const V3: &str = r#"
CREATE TABLE connections (
    id                  TEXT PRIMARY KEY,
    connector_id        TEXT NOT NULL,
    identity_id         TEXT NOT NULL REFERENCES identities (id) ON DELETE CASCADE,
    account_id          TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    label               TEXT NOT NULL,
    account_fingerprint TEXT NOT NULL,
    auth_kind           TEXT NOT NULL,
    credential          BLOB NOT NULL,
    created_at          TEXT NOT NULL,
    last_checked_at     TEXT
);
CREATE UNIQUE INDEX idx_connections_account
    ON connections (connector_id, account_fingerprint);
CREATE INDEX idx_connections_identity ON connections (identity_id);

-- The most recent discovery for a connection, kept so the review screen can be
-- reopened without spending another request. Provider data only; no credential.
CREATE TABLE discoveries (
    connection_id TEXT PRIMARY KEY REFERENCES connections (id) ON DELETE CASCADE,
    payload       TEXT NOT NULL,
    fetched_at    TEXT NOT NULL
);
"#;

/// v4 makes manual entry a first-class way in, alongside Smart Paste and
/// connectors.
///
/// Until now a row could only be created by recognising something: a paste the
/// detectors understood, or a provider a connector could read. That left the
/// larger half of a developer's life unrepresentable -- the hosting panel with
/// no API, the registrar, the bank, the account whose password lives in a
/// browser. v4 removes the three structural obstacles:
///
/// - **One email per identity.** `identities.email` stays as the primary
///   address; `identity_emails` holds every address, primary included, so one
///   person can hold accounts under several addresses without becoming several
///   people.
/// - **Nowhere to put a login.** Accounts gain the fields you actually need to
///   sign in by hand, and `secrets` gains `account_id` so a password can belong
///   to the account rather than being forced under a project.
/// - **One variable name per project.** The unique index now includes the
///   environment, so `DATABASE_URL` can exist for development and production at
///   once instead of one silently blocking the other.
///
/// The `secrets` rebuild is the same shape as v2's, and safe for the same
/// reason the runner now guarantees: foreign keys are off while migrating, so
/// dropping the old table cannot cascade into `secret_values`.
const V4: &str = r#"
CREATE TABLE identity_emails (
    id          TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES identities (id) ON DELETE CASCADE,
    address     TEXT NOT NULL,
    blind_index TEXT NOT NULL,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_identity_emails_bi ON identity_emails (blind_index);
CREATE INDEX idx_identity_emails_identity ON identity_emails (identity_id);

INSERT INTO identity_emails (id, identity_id, address, blind_index, is_primary, created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
       || substr(lower(hex(randomblob(2))), 2) || '-a'
       || substr(lower(hex(randomblob(2))), 2) || '-'
       || lower(hex(randomblob(6))),
       i.id, i.email, i.email_blind_index, 1, i.created_at
FROM identities i
WHERE i.email IS NOT NULL AND i.email_blind_index IS NOT NULL;

ALTER TABLE accounts ADD COLUMN login_email TEXT;
ALTER TABLE accounts ADD COLUMN username TEXT;
ALTER TABLE accounts ADD COLUMN url TEXT;
ALTER TABLE accounts ADD COLUMN notes TEXT;

ALTER TABLE service_projects ADD COLUMN url TEXT;
ALTER TABLE service_projects ADD COLUMN notes TEXT;

CREATE TABLE secrets_v4 (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT REFERENCES projects (id) ON DELETE CASCADE,
    service_project_id TEXT REFERENCES service_projects (id) ON DELETE CASCADE,
    account_id         TEXT REFERENCES accounts (id) ON DELETE CASCADE,
    kind               TEXT NOT NULL,
    name               TEXT NOT NULL,
    preview            TEXT NOT NULL,
    value_blind_index  TEXT NOT NULL,
    environment        TEXT NOT NULL,
    notes              TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    CHECK (project_id IS NOT NULL
        OR service_project_id IS NOT NULL
        OR account_id IS NOT NULL)
);

INSERT INTO secrets_v4
    (id, project_id, service_project_id, account_id, kind, name, preview,
     value_blind_index, environment, notes, created_at, updated_at)
SELECT id, project_id, service_project_id, NULL, kind, name, preview,
       value_blind_index, environment, NULL, created_at, updated_at
FROM secrets;

DROP TABLE secrets;
ALTER TABLE secrets_v4 RENAME TO secrets;

CREATE INDEX idx_secrets_blind_index ON secrets (value_blind_index);
CREATE INDEX idx_secrets_project ON secrets (project_id);
CREATE INDEX idx_secrets_service_project ON secrets (service_project_id);
CREATE INDEX idx_secrets_account ON secrets (account_id);
CREATE UNIQUE INDEX idx_secrets_unique_name
    ON secrets (COALESCE(project_id, ''), COALESCE(service_project_id, ''),
                COALESCE(account_id, ''), name, environment);
"#;
