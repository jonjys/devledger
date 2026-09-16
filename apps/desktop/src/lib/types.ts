// Mirrors of the serde shapes in `devledger-core`.
//
// Note what is absent: there is no `value` field anywhere on a secret. The
// backend only ever sends `preview`, and plaintext arrives solely as the return
// value of `revealSecret`.

export type Provider =
  | "supabase"
  | "postgres"
  | "github"
  | "stripe"
  | "openai"
  | "aws"
  | "vercel"
  | "unknown";

export type Environment = "development" | "staging" | "production" | "unknown";

export type SecretKind =
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
  | "password";

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
  | { sort: "new"; kind: EntityKind; label: string; entity_index: number | null };

export type RelationKind = "owns" | "authenticates_to" | "bills" | "same_as";

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

export interface ParsedSubscription {
  plan: string;
  status: SubscriptionStatus;
  amount_cents: number | null;
  currency: string | null;
  interval: "monthly" | "yearly" | null;
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
  proposed_relations: ProposedRelation[];
  warnings: Warning[];
  subscription: ParsedSubscription | null;
  provenance: Provenance;
  blocks_save: boolean;
  inferred_project_ref: string | null;
}

export interface CommitOutcome {
  secrets_created: number;
  secrets_updated: number;
  entities_skipped: number;
  projects_created: number;
  identities_created: number;
  relations_created: number;
  touched_project_ids: string[];
}

export interface Project {
  id: string;
  organization_id: string;
  provider_project_ref: string | null;
  name: string;
  region: string | null;
  environment: Environment;
  created_at: string;
}

export interface ProjectSummary {
  project: Project;
  organization_name: string;
  secret_count: number;
}

export interface SecretRecord {
  id: string;
  project_id: string;
  kind: SecretKind;
  name: string;
  preview: string;
  value_blind_index: string;
  environment: Environment;
  created_at: string;
  updated_at: string;
}

export interface VaultEntry {
  secret: SecretRecord;
  client_unsafe: boolean;
  provider: Provider;
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
