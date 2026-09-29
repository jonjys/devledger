// Mirrors of the serde shapes in `devledger-core`.
//
// Note what is absent: there is no `value` field anywhere on a secret. The
// backend only ever sends `preview`, and plaintext arrives solely as the return
// value of `revealSecret`.

// The provider tag that crosses IPC is the same string DevLedger stores on
// disk: `github`, `openai`, and so on. A service DevLedger has no built-in
// knowledge of travels as `other:<name>`, so a registrar or a bank is a
// first-class provider rather than being squeezed into "unknown".
//
// An earlier build derived this tag from serde's snake_case, which spelled
// GitHub `git_hub` -- different from what the database held, and the cause of a
// bug where adding a GitHub account by hand failed. There is now one spelling.
// The backend still accepts the old one inbound, so nothing that sends it
// breaks, but it only ever sends the canonical key.
export type KnownProvider =
  | "supabase"
  | "postgres"
  | "github"
  | "stripe"
  | "openai"
  | "aws"
  | "vercel"
  | "anthropic"
  | "unknown";

/** A known provider, or `other:<name>` for any service the user names. */
export type Provider = KnownProvider | `other:${string}`;

export type Environment = "development" | "staging" | "production" | "unknown";

// The backend sends `github_token` and `openai_api_key`. Earlier builds
// derived these with serde's snake_case and sent `git_hub_token` and
// `open_ai_api_key`; those spellings are still listed so nothing renders as a
// raw tag, and `normalizeSecretKind` maps them to the canonical ones.
export type SecretKind =
  | "git_hub_token"
  | "open_ai_api_key"
  | "supabase_anon_key"
  | "supabase_service_role_key"
  | "postgres_connection_string"
  | "jwt_secret"
  | "github_token"
  | "stripe_secret_key"
  | "openai_api_key"
  | "aws_access_key_id"
  | "aws_secret_access_key"
  | "generic_api_key"
  | "password"
  | "env_var";

export type EvidenceLevel = "explicit" | "strong" | "heuristic" | "weak";

export interface Evidence {
  level: EvidenceLevel;
  reason: string;
  rule: string;
}

export type DetectedKind =
  | "secret"
  | "project_ref"
  | "project_url"
  | "email"
  | "env_var"
  | "subscription_plan"
  | "region";

export interface DetectedEntity {
  index: number;
  kind: DetectedKind;
  label: string;
  /** Masked for secrets, literal for everything else. Never the raw value. */
  value_preview: string;
  secret_kind: SecretKind | null;
  provider: Provider;
  environment: Environment;
  project_ref: string | null;
  evidence: Evidence;
}

export type EntityKind =
  | "identity"
  | "account"
  | "organization"
  | "service_project"
  | "project"
  | "secret"
  | "subscription";

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export type MatchType =
  | "exact_value"
  | "same_name_different_value"
  | "same_project_ref"
  | "same_name"
  | "same_email";

export interface ExistingMatch {
  entity_index: number;
  matched: EntityRef;
  match_type: MatchType;
  label: string;
  detail: string;
}

export type ProposedEndpoint =
  | { sort: "existing"; entity: EntityRef; label: string }
  | { sort: "new"; kind: EntityKind; label: string; entity_index: number | null }
  | { sort: "chain"; role: ChainRole; label: string };

export type RelationKind =
  | "owns"
  | "member_of"
  | "contains"
  | "used_by"
  | "authenticates_to"
  | "bills"
  | "same_as";

export const RELATION_VERB: Record<RelationKind, string> = {
  owns: "owns",
  member_of: "is a member of",
  contains: "contains",
  used_by: "is used by",
  authenticates_to: "authenticates to",
  bills: "bills",
  same_as: "is the same as",
};

/** Where a node sits in the Identity → … → Project chain. */
export type ChainRole =
  | "identity"
  | "account"
  | "organization"
  | "service_project"
  | "project";

export const CHAIN_ROLE_LABEL: Record<ChainRole, string> = {
  identity: "Identity",
  account: "Account",
  organization: "Organization",
  service_project: "Service project",
  project: "Project",
};

export interface ChainNode {
  role: ChainRole;
  label: string;
  existing_id: string | null;
  evidence: Evidence;
  entity_index: number | null;
}

/**
 * The chain a paste implies. Any rung may be null, which means the paste did
 * not say — DevLedger raises an OpenQuestion rather than filling it in.
 */
export interface ProposedChain {
  identity: ChainNode | null;
  account: ChainNode | null;
  organization: ChainNode | null;
  service_project: ChainNode | null;
  project: ChainNode | null;
}

export type QuestionKind =
  | "which_project"
  | "which_organization"
  | "which_identity"
  | "label_role";

export interface QuestionCandidate {
  existing: EntityRef | null;
  label: string;
  reason: string;
  recommended: boolean;
}

export interface OpenQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  candidates: QuestionCandidate[];
  allow_free_text: boolean;
  required: boolean;
}

export type AnswerChoice =
  | { sort: "existing"; entity: EntityRef }
  | { sort: "new_named"; name: string }
  | { sort: "unknown" };

export interface QuestionAnswer {
  question_id: string;
  choice: AnswerChoice;
}

export interface ProposedRelation {
  index: number;
  from: ProposedEndpoint;
  to: ProposedEndpoint;
  kind: RelationKind;
  evidence: Evidence;
  selected_by_default: boolean;
}

export type RecommendedAction =
  | { sort: "create" }
  | { sort: "update"; secret_id: string }
  | { sort: "skip"; reason: string };

export type EntityDecision =
  | { sort: "accept" }
  | { sort: "change"; secret_id: string }
  | { sort: "create_new" }
  | { sort: "skip" };

export interface ReviewDecision {
  entity_index: number;
  decision: EntityDecision;
  name_override: string | null;
}

export interface ReviewSubmission {
  analysis_id: string;
  decisions: ReviewDecision[];
  accepted_relations: number[];
  acknowledge_critical: boolean;
  target_project_id: string | null;
  answers: QuestionAnswer[];
}

export type Severity = "info" | "warning" | "critical";

export type WarningCode =
  | "server_secret_in_client_variable"
  | "project_ref_mismatch"
  | "duplicate_secret"
  | "secret_rotated"
  | "expired_credential"
  | "unattributed_secret"
  | "nothing_detected";

export interface Warning {
  code: WarningCode;
  severity: Severity;
  title: string;
  detail: string;
  entity_indexes: number[];
}

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "free"
  | "unknown";

export type BillingInterval = "monthly" | "yearly";

export interface ParsedSubscription {
  plan: string;
  status: SubscriptionStatus;
  amount_cents: number | null;
  currency: string | null;
  interval: "monthly" | "yearly" | null;
  trial_ends_at: string | null;
}

export type SourceKind = "smart_paste" | "env_file" | "manual";

export interface Provenance {
  redacted_excerpt: string;
  source: SourceKind;
  original_len: number;
  captured_at: string;
}

export interface PasteAnalysis {
  analysis_id: string;
  entities: DetectedEntity[];
  recommendations: RecommendedAction[];
  matches: ExistingMatch[];
  chain: ProposedChain;
  questions: OpenQuestion[];
  proposed_relations: ProposedRelation[];
  warnings: Warning[];
  subscription: ParsedSubscription | null;
  provenance: Provenance;
  blocks_save: boolean;
  provider: Provider;
}

export interface CommitOutcome {
  secrets_created: number;
  secrets_updated: number;
  entities_skipped: number;
  projects_created: number;
  identities_created: number;
  accounts_created: number;
  organizations_created: number;
  service_projects_created: number;
  left_unassigned: number;
  relations_created: number;
  touched_project_ids: string[];
  /** Judgement calls made while saving, e.g. which of two accounts was used. */
  notes: string[];
}

/** A DevLedger project: the thing you work on, e.g. "Curl-to-Buy". */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

/** A provider-side resource: a Supabase project, a Vercel project, a repo. */
export interface ServiceProject {
  id: string;
  account_id: string;
  organization_id: string | null;
  provider: Provider;
  provider_ref: string | null;
  name: string;
  region: string | null;
  environment: Environment;
  url: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProjectSummary {
  project: Project;
  service_project_count: number;
  secret_count: number;
  providers: Provider[];
}

export interface ProjectRefLabel {
  id: string;
  name: string;
}

export interface ServiceProjectSummary {
  service_project: ServiceProject;
  account_label: string;
  identity_email: string | null;
  organization_name: string | null;
  secret_count: number;
  used_by: ProjectRefLabel[];
}

export interface Identity {
  id: string;
  label: string;
  email: string | null;
  email_blind_index: string | null;
  created_at: string;
}

export interface Account {
  id: string;
  identity_id: string;
  provider: Provider;
  external_ref: string | null;
  label: string;
  /** The address this account signs in with, when it differs from the identity's. */
  login_email: string | null;
  username: string | null;
  url: string | null;
  notes: string | null;
  created_at: string;
}

/** The editable half of an account. */
export interface AccountDetails {
  login_email: string | null;
  username: string | null;
  url: string | null;
  notes: string | null;
}

/** One email address belonging to an identity. */
export interface IdentityEmail {
  id: string;
  identity_id: string;
  address: string;
  blind_index: string;
  is_primary: boolean;
  created_at: string;
}

export interface Organization {
  id: string;
  account_id: string;
  provider_org_id: string | null;
  name: string;
  created_at: string;
}

export interface Subscription {
  id: string;
  account_id: string;
  plan: string;
  status: SubscriptionStatus;
  amount_cents: number | null;
  currency: string | null;
  interval: "monthly" | "yearly" | null;
  trial_ends_at: string | null;
  created_at: string;
}

export interface SubscriptionSummary {
  subscription: Subscription;
  provider: Provider;
  account_label: string;
  identity_email: string | null;
}

export interface OrganizationNode {
  organization: Organization;
  service_projects: ServiceProjectSummary[];
}

export interface AccountNode {
  account: Account;
  organizations: OrganizationNode[];
  unassigned: ServiceProjectSummary[];
  subscriptions: Subscription[];
}

export interface IdentityNode {
  identity: Identity;
  accounts: AccountNode[];
}

export type AttentionKind =
  | "unassigned_organization"
  | "unlinked_service_project"
  | "identity_without_email"
  | "orphan_secret"
  | "secret_value_missing"
  | "ambiguous_provider_account";

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  detail: string;
  entity: EntityRef;
}

export interface Relation {
  id: string;
  from: EntityRef;
  to: EntityRef;
  kind: RelationKind;
  evidence: Evidence;
  created_at: string;
}

export interface SecretRecord {
  id: string;
  project_id: string | null;
  service_project_id: string | null;
  account_id: string | null;
  kind: SecretKind;
  name: string;
  preview: string;
  value_blind_index: string;
  environment: Environment;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** What a secret belongs to. Exactly one field is set. */
export interface SecretOwner {
  project_id: string | null;
  service_project_id: string | null;
  account_id: string | null;
}

/**
 * A new secret, as a form supplies it.
 *
 * The value is deliberately not a field: it is passed as its own argument, so
 * a credential never rides along inside a record the rest of the UI handles.
 */
export interface NewSecret {
  owner: SecretOwner;
  kind: SecretKind;
  name: string;
  environment: Environment;
  notes: string | null;
}

/** The editable fields of an existing provider resource. */
export interface ResourceEdit {
  name: string;
  provider_ref: string | null;
  region: string | null;
  environment: Environment;
  url: string | null;
  notes: string | null;
}

/** One variable name a project defines more than once with differing values. */
export interface EnvConflict {
  name: string;
  definitions: EnvDefinition[];
}

export interface EnvDefinition {
  secret_id: string;
  environment: Environment;
  source: string | null;
}

/** What deleting a project would take with it. */
export interface DeletionImpact {
  secrets_deleted: number;
  resources_unlinked: number;
}

/** One person with the whole chain beneath them, address down to project. */
export interface LedgerIdentity {
  identity: Identity;
  emails: IdentityEmail[];
  accounts: AccountNode[];
  projects: ProjectRefLabel[];
  secret_count: number;
}

export interface VaultEntry {
  secret: SecretRecord;
  client_unsafe: boolean;
  provider: Provider;
  service_project_name: string | null;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
}

export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  entity_kind: string | null;
  entity_id: string | null;
  detail: string;
}

export interface IpcError {
  code: string;
  message: string;
}


// --- Connect & Discover ----------------------------------------------------

export type AuthKind =
  | {
      sort: "personal_access_token";
      create_url: string;
      expected_prefix: string;
      guidance: string;
    }
  | { sort: "oauth2_pkce"; authorize_url: string; token_url: string; scopes: string[] };

export interface ConnectorDescriptor {
  id: string;
  display_name: string;
  summary: string;
  auth: AuthKind;
  provider: Provider;
  read_only: boolean;
  allowed_hosts: string[];
}

export interface Connection {
  id: string;
  connector_id: string;
  identity_id: string;
  account_id: string;
  label: string;
  account_fingerprint: string;
  created_at: string;
  last_checked_at: string | null;
}

export interface ConnectionSummary {
  connection: Connection;
  identity_email: string | null;
  organization_count: number;
  resource_count: number;
}

export type MatchStatus =
  | "matched"
  | "unmatched"
  | "possible_match"
  | "conflict"
  | "needs_attention";

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  matched: "Matched",
  unmatched: "Unmatched",
  possible_match: "Possible match",
  conflict: "Conflict",
  needs_attention: "Needs attention",
};

export type ReconcileScope = "organization" | "project";

export interface ReconcileItem {
  scope: ReconcileScope;
  provider_id: string;
  name: string;
  parent_provider_org_id: string | null;
  status: MatchStatus;
  detail: string;
  existing: EntityRef | null;
  selected_by_default: boolean;
  region: string | null;
  status_at_provider: string | null;
  active_at_provider: boolean;
}

export interface ReconcileReport {
  connection_id: string;
  items: ReconcileItem[];
  matched: number;
  unmatched: number;
  possible: number;
  conflicts: number;
  needs_attention: number;
  paused: number;
}

export interface ConnectOutcome {
  connection: Connection;
  reconnected: boolean;
  report: ReconcileReport;
}

export interface ImportOutcome {
  organizations_created: number;
  organizations_updated: number;
  resources_created: number;
  resources_updated: number;
  skipped: number;
  conflicts_refused: number;
}

/** A field the user named themselves, attached to a person, account, project or resource. */
export interface CustomField {
  id: string;
  entity: EntityRef;
  label: string;
  value: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/** A secret with a short label for what it belongs to. */
export interface SecretListing {
  entry: VaultEntry;
  owner: string;
}
