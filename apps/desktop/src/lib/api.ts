// The single place the frontend talks to Rust.
//
// Every function here is a thin, typed wrapper over a Tauri command. Keeping
// them in one file makes the security surface auditable: `revealSecret` is the
// only function in the whole frontend that returns a credential, and
// `copySecret` / `copyEnv` exist so the common flows never need it.

import { invoke } from "@tauri-apps/api/core";

import type {
  Account,
  BillingInterval,
  ConnectionSummary,
  ConnectOutcome,
  ConnectorDescriptor,
  ImportOutcome,
  ReconcileReport,
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
  Provider,
  Relation,
  ReviewSubmission,
  ServiceProject,
  ServiceProjectSummary,
  Subscription,
  SubscriptionStatus,
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

// --- manual entry, re-parenting and deletion -------------------------------
//
// The by-hand counterparts to Smart Paste and Connect. None of these touch the
// network; they write the same graph the automatic paths do.

/** Record a provider account by hand, resolving the identity from an email. */
export const createAccountManual = (
  email: string | null,
  provider: Provider,
  label: string,
  note: string | null,
) => call<Account>("create_account_manual", { email, provider, label, note });

/** Add a provider account under a known identity. */
export const addAccount = (
  identityId: string,
  provider: Provider,
  label: string,
  note: string | null,
) => call<Account>("add_account", { identityId, provider, label, note });

/** Record a provider resource by hand, under an account. */
export const createServiceProjectManual = (
  accountId: string,
  organizationId: string | null,
  provider: Provider,
  name: string,
  reference: string | null,
) =>
  call<ServiceProject>("create_service_project_manual", {
    accountId,
    organizationId,
    provider,
    name,
    reference,
  });

/** Record a subscription by hand, without a paste. */
export const createSubscriptionManual = (input: {
  email: string | null;
  provider: Provider;
  plan: string;
  status: SubscriptionStatus;
  amountCents: number | null;
  currency: string | null;
  interval: BillingInterval | null;
  renewsAt: string | null;
}) => call<Subscription>("create_subscription_manual", input);

/** Move an account under a different identity. */
export const moveAccount = (accountId: string, identityId: string) =>
  call<void>("move_account", { accountId, identityId });

/** Move an organization under a different account. */
export const moveOrganization = (organizationId: string, accountId: string) =>
  call<void>("move_organization", { organizationId, accountId });

/** Move a resource under a different account, clearing its organization. */
export const moveServiceProject = (
  serviceProjectId: string,
  accountId: string,
  organizationId: string | null,
) =>
  call<void>("move_service_project", {
    serviceProjectId,
    accountId,
    organizationId,
  });

/** Delete an account and everything under it. */
export const deleteAccount = (accountId: string) =>
  call<void>("delete_account", { accountId });

/** Delete an organization. Its resources survive, unassigned. */
export const deleteOrganization = (organizationId: string) =>
  call<void>("delete_organization", { organizationId });

/** Delete a provider resource and its secrets. */
export const deleteServiceProject = (serviceProjectId: string) =>
  call<void>("delete_service_project", { serviceProjectId });

/** Delete a subscription. */
export const deleteSubscription = (subscriptionId: string) =>
  call<void>("delete_subscription", { subscriptionId });

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


// --- Connect & Discover ----------------------------------------------------
//
// These are the only calls that cause DevLedger to touch the network, and each
// one is the direct result of a button press. The token is sent to Rust, which
// verifies it against the provider and seals it into the vault; it is never
// stored in the frontend and never comes back.

export const listConnectors = () => call<ConnectorDescriptor[]>("list_connectors");

export const listConnections = () => call<ConnectionSummary[]>("list_connections");

/** Verify a token against the provider, store it, and return what it found. */
export const connectorConnect = (connector: string, token: string, label: string) =>
  call<ConnectOutcome>("connector_connect", { connector, token, label });

/** Re-read a connected account using the credential already in the vault. */
export const connectorRefresh = (connectionId: string) =>
  call<ReconcileReport>("connector_refresh", { connectionId });

/** The review screen for the last discovery, without spending a request. */
export const connectorReport = (connectionId: string) =>
  call<ReconcileReport>("connector_report", { connectionId });

/** Apply the ticked rows. */
export const connectorImport = (connectionId: string, accepted: string[]) =>
  call<ImportOutcome>("connector_import", { connectionId, accepted });

/** Forget a connection. Imported data is kept. */
export const connectorDisconnect = (connectionId: string) =>
  call<void>("connector_disconnect", { connectionId });
