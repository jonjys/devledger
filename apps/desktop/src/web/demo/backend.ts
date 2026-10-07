// An in-memory stand-in for the Rust backend, for the browser demo only.
//
// The desktop app never loads this file: the web build swaps
// `@tauri-apps/api/core` for a shim that calls `handle` instead of Rust. It
// answers the same commands with the same JSON shapes, so the real UI runs
// unchanged on sample data. Nothing is written anywhere -- reloading the page
// starts over -- and the features that would need the real vault or the
// network (Smart Paste, connecting a provider) say so instead of pretending.

import { providerInfo } from "../../lib/providers";
import type {
  Account,
  AccountDetails,
  AccountNode,
  AttentionItem,
  AuditEntry,
  CustomField,
  EntityKind,
  EntityRef,
  Environment,
  IdentityEmail,
  IdentityNode,
  LedgerIdentity,
  NewSecret,
  Organization,
  Project,
  ProjectRefLabel,
  ProjectSummary,
  Provider,
  Relation,
  ResourceEdit,
  SecretRecord,
  SecretListing,
  ServiceProject,
  ServiceProjectSummary,
  Subscription,
  SubscriptionSummary,
  VaultEntry,
} from "../../lib/types";

import { maskPreview, newId, now, seed, type DemoDb } from "./seed";

/** What the shim throws: the same `{code, message}` the Rust side sends. */
export interface DemoError {
  code: string;
  message: string;
}

const fail = (code: string, message: string): never => {
  throw { code, message } satisfies DemoError;
};
const invalid = (message: string) => fail("invalid", message);
const notFound = (what: string) => fail("not_found", `${what} not found`);

export const PASTE_DESKTOP_ONLY =
  "Smart Paste runs in the desktop app, where a paste is analysed inside the encrypted vault. In this demo, add things by hand with + Add or on the map.";

export const CONNECT_DESKTOP_ONLY =
  "Connecting a provider runs in the desktop app. The demo stores no tokens and makes no requests to any provider.";

let db: DemoDb = seed();
let unlocked = true;
let audit: AuditEntry[] = [];

/** Start over with the sample vault. Used by tests and the demo's reset button. */
export function reset() {
  db = seed();
  unlocked = true;
  audit = [];
}

/** Copy text to the clipboard, the way Rust does for the desktop app. */
let clipboard: (text: string) => Promise<void> = async (text) => {
  await navigator.clipboard?.writeText(text);
};
export function setClipboard(write: (text: string) => Promise<void>) {
  clipboard = write;
}

function log(action: string, kind: string | null, id: string | null, detail: string) {
  audit.unshift({ seq: audit.length + 1, at: now(), action, entity_kind: kind, entity_id: id, detail });
}

// --- lookups --------------------------------------------------------------------

const label = (p: Provider) =>
  providerInfo(p)?.name ?? (p.startsWith("other:") ? p.slice("other:".length) : "Unknown");

const find = <T extends { id: string }>(rows: T[], id: string, what: string): T =>
  rows.find((r) => r.id === id) ?? notFound(what);

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

function clean(value: unknown, what: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) invalid(what);
  return s;
}

const optional = (value: unknown): string | null => {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : null;
};

function projectsUsing(resourceId: string): ProjectRefLabel[] {
  return db.usedBy
    .filter(([r]) => r === resourceId)
    .map(([, p]) => db.projects.find((x) => x.id === p))
    .filter((p): p is Project => !!p)
    .sort(byName)
    .map((p) => ({ id: p.id, name: p.name }));
}

function resourcesFor(projectId: string): ServiceProject[] {
  const ids = new Set(db.usedBy.filter(([, p]) => p === projectId).map(([r]) => r));
  return db.resources.filter((r) => ids.has(r.id));
}

function resourceSummary(sp: ServiceProject): ServiceProjectSummary {
  const account = db.accounts.find((a) => a.id === sp.account_id);
  const identity = db.identities.find((i) => i.id === account?.identity_id);
  return {
    service_project: sp,
    account_label: account?.label ?? "",
    identity_email: identity?.email ?? null,
    organization_name: db.orgs.find((o) => o.id === sp.organization_id)?.name ?? null,
    secret_count: db.secrets.filter((s) => s.service_project_id === sp.id).length,
    used_by: projectsUsing(sp.id),
  };
}

function secretsForProject(projectId: string): SecretRecord[] {
  const resources = new Set(resourcesFor(projectId).map((r) => r.id));
  return db.secrets
    .filter((s) => s.project_id === projectId || (s.service_project_id && resources.has(s.service_project_id)))
    .sort(byName);
}

const PROVIDER_OF_KIND: Partial<Record<SecretRecord["kind"], Provider>> = {
  supabase_anon_key: "supabase",
  supabase_service_role_key: "supabase",
  jwt_secret: "supabase",
  postgres_connection_string: "postgres",
  github_token: "github",
  git_hub_token: "github",
  stripe_secret_key: "stripe",
  openai_api_key: "openai",
  open_ai_api_key: "openai",
  aws_access_key_id: "aws",
  aws_secret_access_key: "aws",
};

function decorate(secret: SecretRecord): VaultEntry {
  return {
    secret,
    client_unsafe: secret.kind !== "supabase_anon_key",
    provider: PROVIDER_OF_KIND[secret.kind] ?? "unknown",
    service_project_name: db.resources.find((r) => r.id === secret.service_project_id)?.name ?? null,
  };
}

function ownerLabel(s: SecretRecord): string {
  const project = db.projects.find((p) => p.id === s.project_id);
  if (project) return project.name;
  const account = db.accounts.find((a) => a.id === s.account_id);
  if (account) return `${label(account.provider)} · ${account.label}`;
  const resource = db.resources.find((r) => r.id === s.service_project_id);
  if (resource) {
    const first = projectsUsing(resource.id)[0];
    return first ? `${first.name} via ${resource.name}` : resource.name;
  }
  return "Nothing";
}

function accountNode(account: Account): AccountNode {
  const mine = db.resources.filter((r) => r.account_id === account.id);
  return {
    account,
    organizations: db.orgs
      .filter((o) => o.account_id === account.id)
      .map((organization) => ({
        organization,
        service_projects: db.resources
          .filter((r) => r.organization_id === organization.id)
          .map(resourceSummary),
      })),
    unassigned: mine.filter((r) => !r.organization_id).map(resourceSummary),
    subscriptions: db.subscriptions.filter((s) => s.account_id === account.id),
  };
}

function identityGraph(): IdentityNode[] {
  return db.identities.map((identity) => ({
    identity,
    accounts: db.accounts.filter((a) => a.identity_id === identity.id).map(accountNode),
  }));
}

function overview(): LedgerIdentity[] {
  return identityGraph().map(({ identity, accounts }) => {
    const projects: ProjectRefLabel[] = [];
    let secretCount = 0;
    for (const node of accounts) {
      secretCount += db.secrets.filter((s) => s.account_id === node.account.id).length;
      for (const r of [...node.organizations.flatMap((o) => o.service_projects), ...node.unassigned]) {
        secretCount += r.secret_count;
        for (const p of r.used_by) if (!projects.some((x) => x.id === p.id)) projects.push(p);
      }
    }
    projects.sort(byName);
    return {
      identity,
      emails: db.emails.filter((e) => e.identity_id === identity.id),
      accounts,
      projects,
      secret_count: secretCount,
    };
  });
}

function needsAttention(): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const sp of db.resources) {
    const expected = sp.provider === "supabase" || db.orgs.some((o) => o.account_id === sp.account_id);
    if (!sp.organization_id && expected) {
      items.push({
        kind: "unassigned_organization",
        title: `${sp.name} has no organization`,
        detail: `DevLedger does not know which ${label(sp.provider)} organization owns this resource. Assign it so the map is accurate.`,
        entity: { kind: "service_project", id: sp.id },
      });
    }
    const holdsKeys = db.secrets.some((s) => s.service_project_id === sp.id);
    if (holdsKeys && projectsUsing(sp.id).length === 0) {
      items.push({
        kind: "unlinked_service_project",
        title: `${sp.name} is not used by any project`,
        detail: "Link it to the project that uses it, so its secrets appear in that project's vault.",
        entity: { kind: "service_project", id: sp.id },
      });
    }
  }
  for (const identity of db.identities) {
    if (!identity.email) {
      items.push({
        kind: "identity_without_email",
        title: `${identity.label} has no email`,
        detail: "Without an email, DevLedger cannot match future pastes to this identity.",
        entity: { kind: "identity", id: identity.id },
      });
    }
  }
  for (const s of db.secrets) {
    if (!s.project_id && !s.service_project_id && !s.account_id) {
      items.push({
        kind: "orphan_secret",
        title: `${s.name} is filed against nothing`,
        detail: "Attach it to a project, a resource or an account.",
        entity: { kind: "secret", id: s.id },
      });
    }
  }
  return items;
}

function subscriptions(): SubscriptionSummary[] {
  return db.subscriptions.map((subscription) => {
    const account = db.accounts.find((a) => a.id === subscription.account_id);
    return {
      subscription,
      provider: account?.provider ?? "unknown",
      account_label: account?.label ?? "",
      identity_email: db.identities.find((i) => i.id === account?.identity_id)?.email ?? null,
    };
  });
}

// --- writes -----------------------------------------------------------------------

function identityForEmail(email: string | null): string {
  const address = optional(email);
  if (!address) {
    const existing = db.identities.find((i) => i.label === "Unidentified");
    if (existing) return existing.id;
    return createIdentity("Unidentified", null);
  }
  const hit = db.emails.find((e) => e.address.toLowerCase() === address.toLowerCase());
  return hit ? hit.identity_id : createIdentity(address, address);
}

function createIdentity(labelText: string, email: string | null): string {
  const id = newId();
  const address = optional(email);
  db.identities.push({ id, label: labelText, email: address, email_blind_index: null, created_at: now() });
  if (address) {
    db.emails.push({ id: newId(), identity_id: id, address, blind_index: "demo", is_primary: true, created_at: now() });
  }
  log("identity.create", "identity", id, "Created identity");
  return id;
}

function createAccount(identityId: string, provider: Provider, labelText: string, details: Partial<AccountDetails> = {}) {
  find(db.identities, identityId, "identity");
  const name = clean(labelText, "an account needs a label");
  const account: Account = {
    id: newId(),
    identity_id: identityId,
    provider: provider === "unknown" ? `other:${name}` : provider,
    external_ref: null,
    label: name,
    login_email: optional(details.login_email),
    username: optional(details.username),
    url: optional(details.url),
    notes: optional(details.notes),
    created_at: now(),
  };
  db.accounts.push(account);
  log("account.create", "account", account.id, "Created account");
  return account;
}

function storeSecret(entry: NewSecret, value: string): SecretRecord {
  const name = clean(entry.name, "a secret needs a name");
  if (!value) invalid("a secret needs a value");
  const { project_id, service_project_id, account_id } = entry.owner;
  if ([project_id, service_project_id, account_id].filter(Boolean).length !== 1) {
    invalid("a secret belongs to exactly one project, resource or account");
  }
  const record: SecretRecord = {
    id: newId(),
    project_id,
    service_project_id,
    account_id,
    kind: entry.kind,
    name,
    preview: maskPreview(value),
    value_blind_index: `demo-${newId()}`,
    environment: entry.environment,
    notes: optional(entry.notes),
    created_at: now(),
    updated_at: now(),
  };
  db.secrets.push(record);
  db.values.set(record.id, value);
  log("secret.create", "secret", record.id, "Stored secret");
  return record;
}

function dropFields(ids: Set<string>) {
  db.fields = db.fields.filter((f) => !ids.has(f.entity.id));
}

function deleteSecrets(match: (s: SecretRecord) => boolean) {
  for (const s of db.secrets.filter(match)) db.values.delete(s.id);
  db.secrets = db.secrets.filter((s) => !match(s));
}

function deleteResources(ids: Set<string>) {
  deleteSecrets((s) => !!s.service_project_id && ids.has(s.service_project_id));
  db.usedBy = db.usedBy.filter(([r]) => !ids.has(r));
  db.resources = db.resources.filter((r) => !ids.has(r.id));
  dropFields(ids);
}

function deleteAccounts(ids: Set<string>) {
  const orgs = new Set(db.orgs.filter((o) => ids.has(o.account_id)).map((o) => o.id));
  deleteResources(new Set(db.resources.filter((r) => ids.has(r.account_id)).map((r) => r.id)));
  deleteSecrets((s) => !!s.account_id && ids.has(s.account_id));
  db.orgs = db.orgs.filter((o) => !orgs.has(o.id));
  db.subscriptions = db.subscriptions.filter((s) => !ids.has(s.account_id));
  db.accounts = db.accounts.filter((a) => !ids.has(a.id));
  dropFields(new Set([...ids, ...orgs]));
}

function entityExists({ kind, id }: EntityRef): boolean {
  const table: Partial<Record<EntityKind, { id: string }[]>> = {
    identity: db.identities,
    account: db.accounts,
    organization: db.orgs,
    service_project: db.resources,
    project: db.projects,
    secret: db.secrets,
    subscription: db.subscriptions,
  };
  return (table[kind] ?? []).some((r) => r.id === id);
}

function relationsFor(kind: EntityKind, id: string): Relation[] {
  const evidence = { level: "explicit" as const, rule: "user.linked", reason: "Linked by hand in DevLedger" };
  const out: Relation[] = [];
  for (const [r, p] of db.usedBy) {
    if ((kind === "service_project" && r === id) || (kind === "project" && p === id)) {
      out.push({
        id: `${r}-${p}`,
        from: { kind: "service_project", id: r },
        to: { kind: "project", id: p },
        kind: "used_by",
        evidence,
        created_at: now(),
      });
    }
  }
  for (const [i, p] of db.worksOn) {
    if ((kind === "identity" && i === id) || (kind === "project" && p === id)) {
      out.push({
        id: `${i}-${p}`,
        from: { kind: "identity", id: i },
        to: { kind: "project", id: p },
        kind: "works_on",
        evidence,
        created_at: now(),
      });
    }
  }
  return out;
}

function envFor(projectId: string, environment: Environment | null) {
  find(db.projects, projectId, "project");
  const reachable = secretsForProject(projectId).filter((s) => !environment || s.environment === environment);
  const byName = new Map<string, SecretRecord[]>();
  for (const s of reachable) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  return byName;
}

function envConflicts(projectId: string, environment: Environment | null) {
  return [...envFor(projectId, environment)]
    .filter(([, defs]) => new Set(defs.map((d) => db.values.get(d.id))).size > 1)
    .map(([name, defs]) => ({
      name,
      definitions: defs.map((d) => ({
        secret_id: d.id,
        environment: d.environment,
        source: decorate(d).service_project_name,
      })),
    }));
}

const sameRef = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;

const linkOnce = (pairs: [string, string][], a: string, b: string) => {
  if (!pairs.some(([x, y]) => x === a && y === b)) pairs.push([a, b]);
};

// --- the command table --------------------------------------------------------------

// The arguments arrive as the UI sends them; each command reads the ones it needs.
type Args = Record<string, any>;

const OPEN = new Set(["vault_status", "vault_initialize", "vault_unlock", "vault_lock", "list_connectors"]);

const commands: Record<string, (a: Args) => unknown> = {
  // vault lifecycle: the demo has no passphrase; any entry opens it.
  vault_status: () => ({ initialized: true, unlocked }),
  vault_initialize: () => ((unlocked = true), { initialized: true, unlocked }),
  vault_unlock: () => ((unlocked = true), { initialized: true, unlocked }),
  vault_lock: () => ((unlocked = false), { initialized: true, unlocked }),

  // Smart Paste and connectors need the real vault and the network.
  smart_paste_analyze: () => invalid(PASTE_DESKTOP_ONLY),
  smart_paste_commit: () => invalid(PASTE_DESKTOP_ONLY),
  smart_paste_discard: () => undefined,
  list_connectors: () => [
    {
      id: "supabase",
      display_name: "Supabase",
      summary: "Read your organizations and projects so DevLedger can map them.",
      auth: {
        sort: "personal_access_token",
        create_url: "https://supabase.com/dashboard/account/tokens",
        expected_prefix: "sbp_",
        guidance: "Available in the desktop app.",
      },
      provider: "supabase",
      read_only: true,
      allowed_hosts: ["api.supabase.com"],
    },
  ],
  list_connections: () => [],
  connector_connect: () => invalid(CONNECT_DESKTOP_ONLY),
  connector_refresh: () => invalid(CONNECT_DESKTOP_ONLY),
  connector_report: () => invalid(CONNECT_DESKTOP_ONLY),
  connector_import: () => invalid(CONNECT_DESKTOP_ONLY),
  connector_disconnect: () => invalid(CONNECT_DESKTOP_ONLY),

  // reading
  ledger_overview: overview,
  identity_graph: identityGraph,
  needs_attention: needsAttention,
  list_subscriptions: subscriptions,
  list_identities: () => db.identities,
  accounts_for_identity: ({ identityId }) => db.accounts.filter((a) => a.identity_id === identityId),
  organizations_for_account: ({ accountId }) => db.orgs.filter((o) => o.account_id === accountId),
  identity_emails: ({ identityId }) => db.emails.filter((e) => e.identity_id === identityId),
  identity_project_links: () => db.worksOn.map(([i, p]) => [i, p]),
  list_projects: (): ProjectSummary[] =>
    [...db.projects].sort(byName).map((project) => {
      const resources = resourcesFor(project.id);
      return {
        project,
        service_project_count: resources.length,
        secret_count: secretsForProject(project.id).length,
        providers: [...new Set(resources.map((r) => r.provider))],
      };
    }),
  list_service_projects: () => [...db.resources].sort(byName).map(resourceSummary),
  service_projects_for_project: ({ projectId }) => resourcesFor(projectId),
  list_secrets: ({ projectId }) => secretsForProject(projectId).map(decorate),
  account_secrets: ({ accountId }) => db.secrets.filter((s) => s.account_id === accountId).map(decorate),
  list_all_secrets: (): SecretListing[] =>
    [...db.secrets].sort(byName).map((s) => ({ entry: decorate(s), owner: ownerLabel(s) })),
  relations_for: ({ kind, id }) => relationsFor(kind, id),
  recent_audit: ({ limit }) => audit.slice(0, limit),
  secret_provenance: () => [],
  custom_fields: ({ entity }): CustomField[] =>
    db.fields.filter((f) => sameRef(f.entity, entity)).sort((a, b) => a.position - b.position),
  project_environments: ({ projectId }) => [...new Set(secretsForProject(projectId).map((s) => s.environment))],
  env_conflicts: ({ projectId, environment }) => envConflicts(projectId, environment),
  project_deletion_impact: ({ projectId }) => ({
    secrets_deleted: db.secrets.filter((s) => s.project_id === projectId).length,
    resources_unlinked: db.usedBy.filter(([, p]) => p === projectId).length,
  }),

  // secrets: the demo's values are sample text, but they still only leave
  // this module on an explicit reveal or copy.
  reveal_secret: ({ secretId }) => {
    find(db.secrets, secretId, "secret");
    log("secret.reveal", "secret", secretId, "Revealed secret");
    return db.values.get(secretId) ?? "";
  },
  copy_secret: async ({ secretId }) => {
    find(db.secrets, secretId, "secret");
    await clipboard(db.values.get(secretId) ?? "");
    log("secret.copy", "secret", secretId, "Copied secret");
  },
  copy_env: async ({ projectId, environment }) => {
    if (envConflicts(projectId, environment).length) {
      invalid("some variables are defined more than once with different values");
    }
    const lines = [...envFor(projectId, environment)].map(
      ([name, defs]) => `${name}=${db.values.get(defs[0]!.id) ?? ""}`,
    );
    await clipboard(`${lines.join("\n")}\n`);
    return lines.length;
  },
  store_secret: ({ entry, value }) => storeSecret(entry, value),
  create_manual_secret: ({ projectId, serviceProjectId, name, environment, value }) =>
    storeSecret(
      {
        owner: { project_id: projectId ?? null, service_project_id: serviceProjectId ?? null, account_id: null },
        kind: "generic_api_key",
        name,
        environment,
        notes: null,
      },
      value,
    ),
  update_secret_meta: ({ secretId, name, environment, notes }) => {
    const s = find(db.secrets, secretId, "secret");
    s.name = clean(name, "a secret needs a name");
    s.environment = environment;
    s.notes = optional(notes);
    s.updated_at = now();
  },
  replace_secret_value: ({ secretId, value }) => {
    const s = find(db.secrets, secretId, "secret");
    if (!value) invalid("a secret needs a value");
    db.values.set(s.id, value);
    s.preview = maskPreview(value);
    s.updated_at = now();
  },
  delete_secret: ({ secretId }) => {
    find(db.secrets, secretId, "secret");
    deleteSecrets((s) => s.id === secretId);
  },

  // projects
  create_project: ({ name, description }) => {
    const n = clean(name, "a project needs a name");
    if (db.projects.some((p) => p.name.toLowerCase() === n.toLowerCase())) {
      invalid(`a project called ${n} already exists`);
    }
    const project: Project = { id: newId(), name: n, description: optional(description), created_at: now() };
    db.projects.push(project);
    return project;
  },
  update_project: ({ projectId, name, description }) => {
    const p = find(db.projects, projectId, "project");
    p.name = clean(name, "a project needs a name");
    p.description = optional(description);
  },
  delete_project: ({ projectId }) => {
    find(db.projects, projectId, "project");
    deleteSecrets((s) => s.project_id === projectId);
    db.usedBy = db.usedBy.filter(([, p]) => p !== projectId);
    db.worksOn = db.worksOn.filter(([, p]) => p !== projectId);
    db.projects = db.projects.filter((p) => p.id !== projectId);
    dropFields(new Set([projectId]));
  },
  link_service_project: ({ serviceProjectId, projectId }) => {
    find(db.resources, serviceProjectId, "resource");
    find(db.projects, projectId, "project");
    linkOnce(db.usedBy, serviceProjectId, projectId);
  },
  unlink_service_project: ({ serviceProjectId, projectId }) => {
    db.usedBy = db.usedBy.filter(([r, p]) => !(r === serviceProjectId && p === projectId));
  },
  link_identity_project: ({ identityId, projectId }) => {
    find(db.identities, identityId, "identity");
    find(db.projects, projectId, "project");
    linkOnce(db.worksOn, identityId, projectId);
  },
  unlink_identity_project: ({ identityId, projectId }) => {
    db.worksOn = db.worksOn.filter(([i, p]) => !(i === identityId && p === projectId));
  },

  // people and their addresses
  create_identity_manual: ({ label: l, email }) => {
    const id = createIdentity(clean(l, "a person needs a name"), email);
    return find(db.identities, id, "identity");
  },
  update_identity: ({ identityId, label: l }) => {
    find(db.identities, identityId, "identity").label = clean(l, "a person needs a name");
  },
  delete_identity: ({ identityId }) => {
    find(db.identities, identityId, "identity");
    deleteAccounts(new Set(db.accounts.filter((a) => a.identity_id === identityId).map((a) => a.id)));
    db.emails = db.emails.filter((e) => e.identity_id !== identityId);
    db.worksOn = db.worksOn.filter(([i]) => i !== identityId);
    db.identities = db.identities.filter((i) => i.id !== identityId);
    dropFields(new Set([identityId]));
  },
  add_identity_email: ({ identityId, address, makePrimary }): IdentityEmail => {
    const identity = find(db.identities, identityId, "identity");
    const a = clean(address, "an email needs an address");
    if (!a.includes("@")) invalid("that does not look like an email address");
    if (db.emails.some((e) => e.address.toLowerCase() === a.toLowerCase())) {
      invalid(`${a} already belongs to someone in the ledger`);
    }
    const primary = makePrimary || !db.emails.some((e) => e.identity_id === identityId);
    if (primary) for (const e of db.emails) if (e.identity_id === identityId) e.is_primary = false;
    const email: IdentityEmail = {
      id: newId(),
      identity_id: identityId,
      address: a,
      blind_index: "demo",
      is_primary: primary,
      created_at: now(),
    };
    db.emails.push(email);
    if (primary) identity.email = a;
    return email;
  },
  set_primary_email: ({ identityId, emailId }) => {
    const identity = find(db.identities, identityId, "identity");
    const target = find(db.emails.filter((e) => e.identity_id === identityId), emailId, "email");
    for (const e of db.emails) if (e.identity_id === identityId) e.is_primary = e.id === emailId;
    identity.email = target.address;
  },
  remove_identity_email: ({ identityId, emailId }) => {
    const mine = db.emails.filter((e) => e.identity_id === identityId);
    const target = find(mine, emailId, "email");
    if (target.is_primary && mine.length > 1) invalid("choose another primary address before removing this one");
    db.emails = db.emails.filter((e) => e.id !== emailId);
    if (target.is_primary) find(db.identities, identityId, "identity").email = null;
  },

  // accounts
  create_account_manual: ({ identityId, provider, label: l, details }) =>
    createAccount(identityId, provider, l, details ?? {}),
  add_account: ({ identityId, provider, label: l, note }) => createAccount(identityId, provider, l, { notes: note }),
  create_account_for_email: ({ email, provider, label: l, note }) => {
    clean(l, "an account needs a label");
    return createAccount(identityForEmail(email), provider, l, { notes: note });
  },
  update_account: ({ accountId, label: l, details }) => {
    const a = find(db.accounts, accountId, "account");
    a.label = clean(l, "an account needs a label");
    a.login_email = optional(details?.login_email);
    a.username = optional(details?.username);
    a.url = optional(details?.url);
    a.notes = optional(details?.notes);
  },
  move_account: ({ accountId, identityId }) => {
    find(db.identities, identityId, "identity");
    find(db.accounts, accountId, "account").identity_id = identityId;
  },
  delete_account: ({ accountId }) => {
    find(db.accounts, accountId, "account");
    deleteAccounts(new Set([accountId]));
  },

  // organizations
  create_organization: ({ accountId, name }): Organization => {
    find(db.accounts, accountId, "account");
    const org: Organization = {
      id: newId(),
      account_id: accountId,
      provider_org_id: null,
      name: clean(name, "an organization needs a name"),
      created_at: now(),
    };
    db.orgs.push(org);
    return org;
  },
  rename_organization: ({ organizationId, name }) => {
    find(db.orgs, organizationId, "organization").name = clean(name, "an organization needs a name");
  },
  move_organization: ({ organizationId, accountId }) => {
    find(db.accounts, accountId, "account");
    find(db.orgs, organizationId, "organization").account_id = accountId;
    for (const r of db.resources) if (r.organization_id === organizationId) r.account_id = accountId;
  },
  delete_organization: ({ organizationId }) => {
    find(db.orgs, organizationId, "organization");
    for (const r of db.resources) if (r.organization_id === organizationId) r.organization_id = null;
    db.orgs = db.orgs.filter((o) => o.id !== organizationId);
    dropFields(new Set([organizationId]));
  },
  assign_organization: ({ serviceProjectId, organizationId }) => {
    const r = find(db.resources, serviceProjectId, "resource");
    if (organizationId) r.account_id = find(db.orgs, organizationId, "organization").account_id;
    r.organization_id = organizationId ?? null;
  },

  // resources
  create_service_project_manual: ({ accountId, organizationId, provider, name, providerRef, environment }) => {
    find(db.accounts, accountId, "account");
    const n = clean(name, "a resource needs a name");
    if (organizationId && !db.orgs.some((o) => o.id === organizationId && o.account_id === accountId)) {
      invalid("organization does not belong to this account");
    }
    const sp: ServiceProject = {
      id: newId(),
      account_id: accountId,
      organization_id: organizationId ?? null,
      provider,
      provider_ref: optional(providerRef),
      name: n,
      region: null,
      environment,
      url: null,
      notes: null,
      created_at: now(),
    };
    db.resources.push(sp);
    return sp;
  },
  update_resource: ({ resourceId, edit: raw }) => {
    const edit = raw as ResourceEdit;
    const r = find(db.resources, resourceId, "resource");
    r.name = clean(edit.name, "a resource needs a name");
    r.provider_ref = optional(edit.provider_ref);
    r.region = optional(edit.region);
    r.environment = edit.environment;
    r.url = optional(edit.url);
    r.notes = optional(edit.notes);
  },
  move_service_project: ({ serviceProjectId, accountId, organizationId }) => {
    find(db.accounts, accountId, "account");
    const r = find(db.resources, serviceProjectId, "resource");
    r.account_id = accountId;
    r.organization_id = organizationId ?? null;
  },
  delete_service_project: ({ serviceProjectId }) => {
    find(db.resources, serviceProjectId, "resource");
    deleteResources(new Set([serviceProjectId]));
  },

  // subscriptions
  create_subscription_manual: (a): Subscription => {
    const plan = clean(a.plan, "a subscription needs a plan name");
    const identityId = identityForEmail(a.email);
    const provider: Provider = a.provider;
    const existing = db.accounts.filter((x) => x.identity_id === identityId && x.provider === provider);
    if (existing.length > 1) {
      invalid(`this identity holds ${existing.length} ${label(provider)} accounts; add it from the right account in the map`);
    }
    const account = existing[0] ?? createAccount(identityId, provider, optional(a.email) ?? label(provider));
    const sub: Subscription = {
      id: newId(),
      account_id: account.id,
      plan,
      status: a.status,
      amount_cents: a.amountCents ?? null,
      currency: optional(a.currency),
      interval: a.interval ?? null,
      trial_ends_at: optional(a.renewsAt),
      created_at: now(),
    };
    db.subscriptions.push(sub);
    return sub;
  },
  delete_subscription: ({ subscriptionId }) => {
    find(db.subscriptions, subscriptionId, "subscription");
    db.subscriptions = db.subscriptions.filter((s) => s.id !== subscriptionId);
  },

  // fields the user names
  add_custom_field: ({ entity, label: l, value }): CustomField => {
    if (!entityExists(entity)) notFound(entity.kind);
    const field: CustomField = {
      id: newId(),
      entity,
      label: clean(l, "a field needs a label"),
      value: typeof value === "string" ? value.trim() : "",
      position: db.fields.filter((f) => sameRef(f.entity, entity)).length,
      created_at: now(),
      updated_at: now(),
    };
    db.fields.push(field);
    return field;
  },
  update_custom_field: ({ fieldId, label: l, value }) => {
    const f = find(db.fields, fieldId, "field");
    f.label = clean(l, "a field needs a label");
    f.value = typeof value === "string" ? value.trim() : "";
    f.updated_at = now();
  },
  delete_custom_field: ({ fieldId }) => {
    find(db.fields, fieldId, "field");
    db.fields = db.fields.filter((f) => f.id !== fieldId);
  },
};

/** Answer one command, as the Rust side would. */
export async function handle<T>(command: string, args: Args = {}): Promise<T> {
  const run = commands[command];
  if (!run) fail("unknown", `${command} is not available in the browser demo`);
  if (!unlocked && !OPEN.has(command)) fail("vault_locked", "the vault is locked");
  // A copy, so the UI can never mutate the store by holding on to a result.
  const result = await run!(args);
  return (result === undefined ? undefined : structuredClone(result)) as T;
}

/** Every command the demo answers. */
export const DEMO_COMMANDS = Object.keys(commands);
