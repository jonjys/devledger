// Synthetic vault contents for the Ledger canvas tests. No real addresses or keys.

import { PRIMARY_FIELD, type CanvasData } from "../lib/canvas";
import type {
  Account,
  AccountNode,
  CustomField,
  LedgerIdentity,
  Provider,
  SecretKind,
  SecretListing,
  ServiceProjectSummary,
} from "../lib/types";

export const AT = "2026-09-27T10:00:00Z";

/** A UUID whose first eight hex digits are `prefix`, so short ids are readable. */
export function uuid(prefix: string): string {
  return `${prefix.padEnd(8, "0")}-0000-4000-8000-000000000000`;
}

export function accountNode(
  id: string,
  identityId: string,
  provider: Provider,
  label: string,
  extra: Partial<Account> = {},
): AccountNode {
  return {
    account: {
      id,
      identity_id: identityId,
      provider,
      external_ref: null,
      label,
      login_email: null,
      username: null,
      url: null,
      notes: null,
      created_at: AT,
      ...extra,
    },
    organizations: [],
    unassigned: [],
    subscriptions: [],
  };
}

export function person(
  id: string,
  email: string | null,
  label: string,
  accounts: AccountNode[],
): LedgerIdentity {
  return {
    identity: { id, label, email, email_blind_index: null, created_at: AT },
    emails: email
      ? [{ id: `${id}-e`, identity_id: id, address: email, blind_index: "bi", is_primary: true, created_at: AT }]
      : [],
    accounts,
    projects: [],
    secret_count: 0,
  };
}

export function secret(
  id: string,
  owner: { account_id?: string; project_id?: string; service_project_id?: string },
  kind: SecretKind,
  name: string,
): SecretListing {
  return {
    entry: {
      secret: {
        id,
        project_id: owner.project_id ?? null,
        service_project_id: owner.service_project_id ?? null,
        account_id: owner.account_id ?? null,
        kind,
        name,
        preview: "ex•••le",
        value_blind_index: `bi-${id}`,
        environment: "unknown",
        notes: null,
        created_at: AT,
        updated_at: AT,
      },
      client_unsafe: false,
      provider: "unknown",
      service_project_name: null,
    },
    owner: "",
  };
}

export function field(
  id: string,
  entity: { kind: "identity" | "account" | "organization" | "service_project" | "project"; id: string },
  label: string,
  value: string,
): CustomField {
  return { id, entity, label, value, position: 0, created_at: AT, updated_at: AT };
}

export function resource(
  id: string,
  accountId: string,
  name: string,
  usedBy: { id: string; name: string }[],
  opts: { organizationId?: string; provider?: Provider } = {},
): ServiceProjectSummary {
  return {
    service_project: {
      id,
      account_id: accountId,
      organization_id: opts.organizationId ?? null,
      provider: opts.provider ?? "supabase",
      provider_ref: null,
      name,
      region: null,
      environment: "production",
      url: null,
      notes: null,
      created_at: AT,
    },
    account_label: "",
    identity_email: null,
    organization_name: null,
    secret_count: 0,
    used_by: usedBy,
  };
}

export const IDS = {
  me: uuid("1d000001"),
  other: uuid("1d000002"),
  work: uuid("1d000003"),
  github: uuid("ac000001"),
  stripe: uuid("ac000002"),
  supabase: uuid("ac000003"),
  loopia: uuid("ac000004"),
  ghPassword: uuid("5e000001"),
  stripeKey: uuid("5e000002"),
  projectVar: uuid("5e000003"),
  project: uuid("9a000001"),
  blog: uuid("9a000002"),
  resource: uuid("5b000001"),
  stripeShop: uuid("5b000002"),
  org: uuid("0a000001"),
  primaryField: uuid("cf000001"),
  githubPos: uuid("cf000002"),
};

/**
 * Two people with an email and one without. Supabase holds an organization,
 * "acme's Org", with one project in it, "shop-db", which "shop" runs on. "shop"
 * also uses Stripe, through the resource drawing that line made. "blog" uses
 * nothing yet. GitHub has been moved by hand.
 */
export function canvasVault(opts: { pinned?: boolean } = {}): CanvasData {
  const shopDb = resource(IDS.resource, IDS.supabase, "shop-db", [{ id: IDS.project, name: "shop" }], {
    organizationId: IDS.org,
  });
  const stripeShop = resource(IDS.stripeShop, IDS.stripe, "shop", [{ id: IDS.project, name: "shop" }], {
    provider: "stripe",
  });
  const supabase = accountNode(IDS.supabase, IDS.me, "supabase", "Supabase");
  supabase.organizations = [
    {
      organization: { id: IDS.org, account_id: IDS.supabase, provider_org_id: null, name: "acme's Org", created_at: AT },
      service_projects: [shopDb],
    },
  ];
  const me = person(IDS.me, "primary@example.com", "Primary Person", [
    accountNode(IDS.github, IDS.me, "github", "GitHub", { username: "octo-example" }),
    accountNode(IDS.stripe, IDS.me, "stripe", "Stripe"),
    supabase,
  ]);
  const work = person(IDS.work, "work@example.com", "work@example.com", []);
  const other = person(IDS.other, null, "Unidentified", [
    accountNode(IDS.loopia, IDS.other, "other:Loopia", "Loopia"),
  ]);
  const fields = new Map<string, CustomField[]>();
  fields.set(`account:${IDS.github}`, [
    field(IDS.githubPos, { kind: "account", id: IDS.github }, "_pos", "320,-40"),
  ]);
  if (opts.pinned) {
    fields.set(`email:${IDS.work}`, [field(IDS.primaryField, { kind: "identity", id: IDS.work }, PRIMARY_FIELD, "{}")]);
  }
  return {
    people: [other, me, work],
    secrets: [
      secret(IDS.ghPassword, { account_id: IDS.github }, "password", "Password"),
      secret(IDS.stripeKey, { account_id: IDS.stripe }, "stripe_secret_key", "STRIPE_SECRET_KEY"),
      secret(IDS.projectVar, { project_id: IDS.project }, "env_var", "DATABASE_URL"),
    ],
    fields,
    attention: [],
    worksOn: [],
    resources: [shopDb, stripeShop],
    projects: [
      { id: IDS.project, name: "shop" },
      { id: IDS.blog, name: "blog" },
    ],
  };
}
