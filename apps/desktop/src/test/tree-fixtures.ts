// Synthetic vault contents for the skill tree tests. No real addresses or keys.

import type { SkillData } from "../lib/skillTree";
import { STATE_FIELD } from "../lib/skillTree";
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
  entity: { kind: "identity" | "account"; id: string },
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
): ServiceProjectSummary {
  return {
    service_project: {
      id,
      account_id: accountId,
      organization_id: null,
      provider: "supabase",
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
  github: uuid("ac000001"),
  stripe: uuid("ac000002"),
  supabase: uuid("ac000003"),
  loopia: uuid("ac000004"),
  ghPassword: uuid("5e000001"),
  stripeKey: uuid("5e000002"),
  projectVar: uuid("5e000003"),
  project: uuid("9a000001"),
  resource: uuid("5b000001"),
  stateField: uuid("cf000001"),
  supabaseNote: uuid("cf000002"),
};

/**
 * One primary person with three accounts, two of them in categories, and a
 * second person without an email holding a Loopia account.
 */
export function vault(state: string | null = null): SkillData {
  const me = person(IDS.me, "primary@example.com", "Primary Person", [
    accountNode(IDS.github, IDS.me, "github", "GitHub", { username: "octo-example" }),
    accountNode(IDS.stripe, IDS.me, "stripe", "Stripe"),
    accountNode(IDS.supabase, IDS.me, "supabase", "Supabase"),
  ]);
  const other = person(IDS.other, null, "Unidentified", [
    accountNode(IDS.loopia, IDS.other, "other:Loopia", "Loopia"),
  ]);
  const identityFields = new Map<string, CustomField[]>();
  if (state !== null) {
    identityFields.set(IDS.me, [field(IDS.stateField, { kind: "identity", id: IDS.me }, STATE_FIELD, state)]);
  }
  return {
    people: [me, other],
    secrets: [
      secret(IDS.ghPassword, { account_id: IDS.github }, "password", "Password"),
      secret(IDS.stripeKey, { account_id: IDS.stripe }, "stripe_secret_key", "STRIPE_SECRET_KEY"),
      secret(IDS.projectVar, { project_id: IDS.project }, "env_var", "DATABASE_URL"),
    ],
    accountFields: new Map([
      [
        IDS.supabase,
        [
          field(IDS.supabaseNote, { kind: "account", id: IDS.supabase }, "Region", "eu-north-1"),
          field(uuid("cf000003"), { kind: "account", id: IDS.supabase }, "_internal", "x"),
        ],
      ],
    ]),
    identityFields,
    attention: [],
    resources: [resource(IDS.resource, IDS.supabase, "shop-db", [{ id: IDS.project, name: "shop" }])],
    projects: [{ id: IDS.project, name: "shop" }],
  };
}
