// The sample vault the browser demo opens with.
//
// Every name, address and key here is invented. The addresses use the
// reserved example.com / example.org domains, and every key says it is fake,
// so nothing in the demo can be mistaken for -- or used as -- a real credential.

import { PRIMARY_FIELD } from "../../lib/canvas";
import type {
  Account,
  CustomField,
  Environment,
  Identity,
  IdentityEmail,
  Organization,
  Project,
  Provider,
  SecretKind,
  SecretRecord,
  ServiceProject,
  Subscription,
} from "../../lib/types";

export interface DemoDb {
  identities: Identity[];
  emails: IdentityEmail[];
  accounts: Account[];
  orgs: Organization[];
  resources: ServiceProject[];
  projects: Project[];
  secrets: SecretRecord[];
  /** Secret values, kept apart from the records the UI lists -- as in the real vault. */
  values: Map<string, string>;
  /** [resourceId, projectId]: a project uses a resource. */
  usedBy: [string, string][];
  /** [identityId, projectId]: a person works on a project. */
  worksOn: [string, string][];
  subscriptions: Subscription[];
  fields: CustomField[];
}

let counter = 0;

/** A fresh v4-shaped id. Deterministic, so the demo reads the same on every load. */
export function newId(): string {
  counter += 1;
  const hex = counter.toString(16).padStart(12, "0");
  return `de300000-0000-4000-8000-${hex}`;
}

export const now = () => new Date().toISOString();

/** The same masking the vault applies: at most a third shown, never more than 4 + 4. */
export function maskPreview(value: string): string {
  const chars = [...value];
  const n = chars.length;
  if (n === 0) return "";
  const budget = Math.floor(n / 3);
  const head = Math.min(budget, 4);
  const tail = Math.min(Math.max(budget - head, 0), 4);
  if (head === 0) return "•".repeat(Math.min(n, 8));
  return `${chars.slice(0, head).join("")}…${chars.slice(n - tail).join("")}`;
}

export function seed(): DemoDb {
  counter = 0;
  const at = "2026-09-01T09:00:00Z";
  const db: DemoDb = {
    identities: [],
    emails: [],
    accounts: [],
    orgs: [],
    resources: [],
    projects: [],
    secrets: [],
    values: new Map(),
    usedBy: [],
    worksOn: [],
    subscriptions: [],
    fields: [],
  };

  const person = (label: string, address: string) => {
    const identity: Identity = {
      id: newId(),
      label,
      email: address,
      email_blind_index: null,
      created_at: at,
    };
    db.identities.push(identity);
    db.emails.push({
      id: newId(),
      identity_id: identity.id,
      address,
      blind_index: "demo",
      is_primary: true,
      created_at: at,
    });
    return identity.id;
  };

  const account = (identityId: string, provider: Provider, label: string, extra: Partial<Account> = {}) => {
    const a: Account = {
      id: newId(),
      identity_id: identityId,
      provider,
      external_ref: null,
      label,
      login_email: null,
      username: null,
      url: null,
      notes: null,
      created_at: at,
      ...extra,
    };
    db.accounts.push(a);
    return a.id;
  };

  const org = (accountId: string, name: string) => {
    const o: Organization = { id: newId(), account_id: accountId, provider_org_id: null, name, created_at: at };
    db.orgs.push(o);
    return o.id;
  };

  const resource = (
    accountId: string,
    organizationId: string | null,
    provider: Provider,
    name: string,
    environment: Environment,
    extra: Partial<ServiceProject> = {},
  ) => {
    const r: ServiceProject = {
      id: newId(),
      account_id: accountId,
      organization_id: organizationId,
      provider,
      provider_ref: null,
      name,
      region: null,
      environment,
      url: null,
      notes: null,
      created_at: at,
      ...extra,
    };
    db.resources.push(r);
    return r.id;
  };

  const project = (name: string, description: string) => {
    const p: Project = { id: newId(), name, description, created_at: at };
    db.projects.push(p);
    return p.id;
  };

  const secret = (
    owner: { project_id?: string; service_project_id?: string; account_id?: string },
    kind: SecretKind,
    name: string,
    environment: Environment,
    value: string,
  ) => {
    const s: SecretRecord = {
      id: newId(),
      project_id: owner.project_id ?? null,
      service_project_id: owner.service_project_id ?? null,
      account_id: owner.account_id ?? null,
      kind,
      name,
      preview: maskPreview(value),
      value_blind_index: `demo-${name}-${environment}`,
      environment,
      notes: null,
      created_at: at,
      updated_at: at,
    };
    db.secrets.push(s);
    db.values.set(s.id, value);
  };

  const field = (kind: CustomField["entity"]["kind"], id: string, label: string, value: string) => {
    const position = db.fields.filter((f) => f.entity.id === id).length;
    db.fields.push({
      id: newId(),
      entity: { kind, id },
      label,
      value,
      position,
      created_at: at,
      updated_at: at,
    });
  };

  // --- people ------------------------------------------------------------------
  const you = person("Demo Developer", "demo@example.com");
  const side = person("Side projects", "weekend@example.org");
  // The canvas puts the identity carrying this marker in the middle.
  field("identity", you, PRIMARY_FIELD, "primary");

  // --- the main address ----------------------------------------------------------
  const github = account(you, "github", "demo-dev", { username: "demo-dev", url: "https://github.com/demo-dev" });
  const vercel = account(you, "vercel", "Demo Dev's team");
  const supabase = account(you, "supabase", "demo@example.com");
  const stripe = account(you, "stripe", "Make It Real (test mode)");

  const studio = org(supabase, "Demo Studio");
  const sbProd = resource(supabase, studio, "supabase", "make-it-real-prod", "production", {
    provider_ref: "abcdefghijklmnopqrst",
    region: "eu-north-1",
  });
  const sbStaging = resource(supabase, studio, "supabase", "make-it-real-staging", "staging", {
    provider_ref: "tsrqponmlkjihgfedcba",
    region: "eu-north-1",
  });
  const repo = resource(github, null, "github", "demo-dev/make-it-real", "unknown", {
    url: "https://github.com/demo-dev/make-it-real",
  });
  const vercelSite = resource(vercel, null, "vercel", "make-it-real", "production", {
    url: "https://make-it-real.example.com",
  });
  const stripeRes = resource(stripe, null, "stripe", "Make It Real", "development");
  // Left unlinked on purpose, so "Needs attention" has something to show.
  const oldSite = resource(vercel, null, "vercel", "old-landing-page", "production");

  // --- the side-project address ----------------------------------------------------
  const sideSupabase = account(side, "supabase", "weekend@example.org");
  const sideOpenAi = account(side, "openai", "Weekend experiments");
  const labs = org(sideSupabase, "Weekend Labs");
  const recipes = resource(sideSupabase, labs, "supabase", "recipe-box", "production", {
    provider_ref: "zyxwvutsrqponmlkjihg",
    region: "us-east-1",
  });
  const sideRepo = resource(github, null, "github", "demo-dev/recipe-box", "unknown");

  // --- projects --------------------------------------------------------------------
  const mir = project("Make It Real", "The SaaS app: Next.js on Vercel, Supabase for data, Stripe for billing.");
  const box = project("Recipe Box", "A weekend project that turned into something.");
  const site = project("Portfolio", "Personal site. Nothing hosted yet.");

  for (const r of [sbProd, sbStaging, repo, vercelSite, stripeRes]) db.usedBy.push([r, mir]);
  for (const r of [recipes, sideRepo]) db.usedBy.push([r, box]);
  db.worksOn.push([you, mir], [you, site], [side, box]);

  field("project", mir, "Domain", "make-it-real.example.com");
  field("project", mir, "Launch", "Q1");
  field("service_project", sbProd, "Backups", "Daily, 7 days");
  field("account", stripe, "Payout account", "Not set up yet");

  // --- keys (all fake) ---------------------------------------------------------------
  secret({ service_project_id: sbProd }, "supabase_anon_key", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "production",
    "demo-anon-key-NOT-REAL-0000000000000000");
  secret({ service_project_id: sbProd }, "supabase_service_role_key", "SUPABASE_SERVICE_ROLE_KEY", "production",
    "demo-service-role-NOT-REAL-1111111111111");
  secret({ service_project_id: sbProd }, "postgres_connection_string", "DATABASE_URL", "production",
    "postgres://demo:not-a-real-password@db.example.com:5432/postgres");
  secret({ service_project_id: sbStaging }, "supabase_anon_key", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "staging",
    "demo-anon-key-staging-NOT-REAL-22222222");
  secret({ service_project_id: stripeRes }, "stripe_secret_key", "STRIPE_SECRET_KEY", "development",
    "sk_test_DEMO_NOT_A_REAL_KEY_3333333333");
  secret({ project_id: mir }, "env_var", "NEXT_PUBLIC_SITE_URL", "production", "https://make-it-real.example.com");
  secret({ service_project_id: recipes }, "supabase_anon_key", "SUPABASE_ANON_KEY", "production",
    "demo-anon-key-recipes-NOT-REAL-4444444");
  secret({ account_id: sideOpenAi }, "openai_api_key", "OPENAI_API_KEY", "development",
    "sk-demo-NOT-A-REAL-OPENAI-KEY-55555555555");
  secret({ service_project_id: oldSite }, "generic_api_key", "FORM_WEBHOOK_SECRET", "production",
    "demo-webhook-secret-NOT-REAL-7777777777");
  secret({ account_id: github }, "github_token", "GITHUB_TOKEN", "development",
    "ghp_DEMO_NOT_A_REAL_TOKEN_666666666666666");

  // --- what it costs ----------------------------------------------------------------
  const sub = (accountId: string, plan: string, status: Subscription["status"], cents: number | null, trialDays?: number) => {
    db.subscriptions.push({
      id: newId(),
      account_id: accountId,
      plan,
      status,
      amount_cents: cents,
      currency: cents === null ? null : "USD",
      interval: cents === null ? null : "monthly",
      trial_ends_at:
        trialDays === undefined ? null : new Date(Date.now() + trialDays * 86_400_000).toISOString().slice(0, 10),
      created_at: at,
    });
  };
  sub(vercel, "Pro", "active", 2000);
  sub(supabase, "Pro", "active", 2500);
  sub(sideOpenAi, "Pay as you go", "trialing", null, 9);
  sub(sideSupabase, "Free", "free", null);

  return db;
}
