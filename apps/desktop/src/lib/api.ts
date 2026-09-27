// The single place the frontend talks to Rust.
//
// Every function here is a thin, typed wrapper over a Tauri command. Keeping
// them in one file makes the security surface auditable: `revealSecret` is the
// only function in the whole frontend that returns a credential, and
// `copySecret` / `copyEnv` exist so the common flows never need it.

import { invoke } from "@tauri-apps/api/core";

import type {
  Account,
  AccountDetails,
  BillingInterval,
  CustomField,
  EntityRef,
  DeletionImpact,
  EnvConflict,
  IdentityEmail,
  LedgerIdentity,
  NewSecret,
  ResourceEdit,
  SecretListing,
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
  Environment,
  Provider,
  SecretRecord,
  PasteAnalysis,
  Project,
  ProjectSummary,
  Provenance,
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

/** Fired when any call finds the vault locked, so the app can return to the gate. */
export const VAULT_LOCKED_EVENT = "devledger:vault-locked";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    if (isIpcError(raw)) {
      if (raw.code === "vault_locked") {
        // The vault can lock without the UI asking -- the idle timer runs in
        // Rust. Whatever screen made this call, the right response is the gate.
        window.dispatchEvent(new Event(VAULT_LOCKED_EVENT));
      }
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

export const createIdentityManual = (label: string, email: string | null) =>
  call<Identity>("create_identity_manual", { label, email });

/**
 * Create an account under an identity. `provider` may be any known provider or
 * `other:<name>` for a service DevLedger has no built-in knowledge of, and the
 * optional `details` record how to sign in.
 */
export const createAccountManual = (
  identityId: string,
  provider: Provider,
  label: string,
  details: AccountDetails | null = null,
) => call<Account>("create_account_manual", { identityId, provider, label, details });

export const createServiceProjectManual = (
  accountId: string,
  organizationId: string | null,
  provider: Provider,
  name: string,
  providerRef: string | null,
  environment: Environment,
) =>
  call<ServiceProject>("create_service_project_manual", {
    accountId,
    organizationId,
    provider,
    name,
    providerRef,
    environment,
  });

export const createManualSecret = (
  projectId: string | null,
  serviceProjectId: string | null,
  name: string,
  environment: Environment,
  value: string,
) =>
  call<SecretRecord>("create_manual_secret", {
    projectId,
    serviceProjectId,
    name,
    environment,
    value,
  });

export const relationsFor = (kind: EntityKind, id: string) =>
  call<Relation[]>("relations_for", { kind, id });

// --- manual entry, re-parenting and deletion -------------------------------
//
// The by-hand counterparts to Smart Paste and Connect. None of these touch the
// network; they write the same graph the automatic paths do.

/** Record a provider account by hand, resolving the identity from an email. */
export const createAccountForEmail = (
  email: string | null,
  provider: Provider,
  label: string,
  note: string | null,
) => call<Account>("create_account_for_email", { email, provider, label, note });

/** Add a provider account under a known identity. */
export const addAccount = (
  identityId: string,
  provider: Provider,
  label: string,
  note: string | null,
) => call<Account>("add_account", { identityId, provider, label, note });

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
export const copyEnv = (projectId: string, environment: Environment | null) =>
  call<number>("copy_env", { projectId, environment });


// --- the ledger: people, their addresses, and everything they hold --------

/** Everyone, each with the whole chain from address down to project. */
export const ledgerOverview = () => call<LedgerIdentity[]>("ledger_overview");

export const updateIdentity = (identityId: string, label: string) =>
  call<void>("update_identity", { identityId, label });

/** Delete a person and every account filed under them. */
export const deleteIdentity = (identityId: string) =>
  call<void>("delete_identity", { identityId });

export const identityEmails = (identityId: string) =>
  call<IdentityEmail[]>("identity_emails", { identityId });

export const addIdentityEmail = (identityId: string, address: string, makePrimary: boolean) =>
  call<IdentityEmail>("add_identity_email", { identityId, address, makePrimary });

export const setPrimaryEmail = (identityId: string, emailId: string) =>
  call<void>("set_primary_email", { identityId, emailId });

export const removeIdentityEmail = (identityId: string, emailId: string) =>
  call<void>("remove_identity_email", { identityId, emailId });

export const updateAccount = (accountId: string, label: string, details: AccountDetails) =>
  call<void>("update_account", { accountId, label, details });

/** Secrets filed against an account itself -- its login password, say. Metadata only. */
export const accountSecrets = (accountId: string) =>
  call<VaultEntry[]>("account_secrets", { accountId });

export const updateResource = (resourceId: string, edit: ResourceEdit) =>
  call<void>("update_resource", { resourceId, edit });

/**
 * Store a password, API key or variable entered by hand.
 *
 * The value crosses to Rust once and is sealed there; this returns metadata
 * only. It is the one call besides `connectorConnect` that sends a credential
 * *to* the backend, and like it, nothing ever sends one back except
 * `revealSecret`.
 */
export const storeSecret = (entry: NewSecret, value: string) =>
  call<SecretRecord>("store_secret", { entry, value });

export const updateSecretMeta = (
  secretId: string,
  name: string,
  environment: Environment,
  notes: string | null,
) => call<void>("update_secret_meta", { secretId, name, environment, notes });

/** Rotate a secret's value, keeping its name and history. */
export const replaceSecretValue = (secretId: string, value: string) =>
  call<void>("replace_secret_value", { secretId, value });

/** Which environments a project's secrets use. */
export const projectEnvironments = (projectId: string) =>
  call<Environment[]>("project_environments", { projectId });

/** Names a .env export would refuse, and where each definition comes from. */
export const envConflicts = (projectId: string, environment: Environment | null) =>
  call<EnvConflict[]>("env_conflicts", { projectId, environment });

/** What deleting a project would take with it, asked before the fact. */
export const projectDeletionImpact = (projectId: string) =>
  call<DeletionImpact>("project_deletion_impact", { projectId });

/** Every secret in the vault, metadata only, each with what it belongs to. */
export const listAllSecrets = () => call<SecretListing[]>("list_all_secrets");

// --- fields the user names --------------------------------------------------

/** Every field the user named on a person, account, project or resource. */
export const customFields = (entity: EntityRef) =>
  call<CustomField[]>("custom_fields", { entity });

export const addCustomField = (entity: EntityRef, label: string, value: string) =>
  call<CustomField>("add_custom_field", { entity, label, value });

export const updateCustomField = (fieldId: string, label: string, value: string) =>
  call<void>("update_custom_field", { fieldId, label, value });

export const deleteCustomField = (fieldId: string) =>
  call<void>("delete_custom_field", { fieldId });

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
