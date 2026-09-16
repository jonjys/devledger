// The single place the frontend talks to Rust.
//
// Every function here is a thin, typed wrapper over a Tauri command. Keeping
// them in one file makes the security surface auditable: `revealSecret` is the
// only function in the whole frontend that returns a credential, and
// `copySecret` / `copyEnv` exist so the common flows never need it.

import { invoke } from "@tauri-apps/api/core";

import type {
  Account,
  AttentionItem,
  AuditEntry,
  CommitOutcome,
  EntityKind,
  Identity,
  IdentityNode,
  IpcError,
  Organization,
  PasteAnalysis,
  Project,
  ProjectSummary,
  Provenance,
  Relation,
  ReviewSubmission,
  ServiceProject,
  ServiceProjectSummary,
  SubscriptionSummary,
  VaultEntry,
  VaultStatus,
} from "./types";

/** An error raised by the Rust side, carrying a stable machine-readable code. */
export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IpcError).code === "string" &&
    typeof (value as IpcError).message === "string"
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    if (isIpcError(raw)) {
      throw new ApiError(raw.code, raw.message);
    }
    throw new ApiError("unknown", String(raw));
  }
}

// --- vault lifecycle -------------------------------------------------------

export const vaultStatus = () => call<VaultStatus>("vault_status");

export const vaultInitialize = (passphrase: string) =>
  call<VaultStatus>("vault_initialize", { passphrase });

export const vaultUnlock = (passphrase: string) =>
  call<VaultStatus>("vault_unlock", { passphrase });

export const vaultLock = () => call<VaultStatus>("vault_lock");

// --- smart paste -----------------------------------------------------------

export const analyzePaste = (text: string) =>
  call<PasteAnalysis>("smart_paste_analyze", { text });

export const discardAnalysis = (analysisId: string) =>
  call<void>("smart_paste_discard", { analysisId });

export const commitReview = (submission: ReviewSubmission) =>
  call<CommitOutcome>("smart_paste_commit", { submission });

// --- vault contents --------------------------------------------------------

export const listProjects = () => call<ProjectSummary[]>("list_projects");

export const listSecrets = (projectId: string) =>
  call<VaultEntry[]>("list_secrets", { projectId });

export const createProject = (name: string, description: string | null) =>
  call<Project>("create_project", { name, description });

export const updateProject = (
  projectId: string,
  name: string,
  description: string | null,
) => call<void>("update_project", { projectId, name, description });

export const deleteProject = (projectId: string) =>
  call<void>("delete_project", { projectId });

// --- the map: identities, accounts, organizations, resources ---------------

export const identityGraph = () => call<IdentityNode[]>("identity_graph");

export const needsAttention = () => call<AttentionItem[]>("needs_attention");

export const listSubscriptions = () =>
  call<SubscriptionSummary[]>("list_subscriptions");

export const listServiceProjects = () =>
  call<ServiceProjectSummary[]>("list_service_projects");

export const serviceProjectsForProject = (projectId: string) =>
  call<ServiceProject[]>("service_projects_for_project", { projectId });

export const assignOrganization = (
  serviceProjectId: string,
  organizationId: string | null,
) => call<void>("assign_organization", { serviceProjectId, organizationId });

export const linkServiceProject = (serviceProjectId: string, projectId: string) =>
  call<void>("link_service_project", { serviceProjectId, projectId });

export const unlinkServiceProject = (serviceProjectId: string, projectId: string) =>
  call<void>("unlink_service_project", { serviceProjectId, projectId });

export const createOrganization = (accountId: string, name: string) =>
  call<Organization>("create_organization", { accountId, name });

export const organizationsForAccount = (accountId: string) =>
  call<Organization[]>("organizations_for_account", { accountId });

export const listIdentities = () => call<Identity[]>("list_identities");

export const accountsForIdentity = (identityId: string) =>
  call<Account[]>("accounts_for_identity", { identityId });

export const relationsFor = (kind: EntityKind, id: string) =>
  call<Relation[]>("relations_for", { kind, id });

export const deleteSecret = (secretId: string) =>
  call<void>("delete_secret", { secretId });

export const secretProvenance = (secretId: string) =>
  call<Provenance[]>("secret_provenance", { secretId });

export const recentAudit = (limit: number) =>
  call<AuditEntry[]>("recent_audit", { limit });

// --- secrets ---------------------------------------------------------------

/**
 * The only call in the frontend that returns a credential.
 *
 * Reaching it requires an explicit user action, and the backend writes an audit
 * entry before returning. Prefer `copySecret` wherever the value only needs to
 * end up on the clipboard.
 */
export const revealSecret = (secretId: string) =>
  call<string>("reveal_secret", { secretId });

/** Copy a secret to the clipboard. The value never enters JavaScript. */
export const copySecret = (secretId: string) =>
  call<void>("copy_secret", { secretId });

/** Copy a project as a `.env` file. Returns how many variables were written. */
export const copyEnv = (projectId: string) =>
  call<number>("copy_env", { projectId });
