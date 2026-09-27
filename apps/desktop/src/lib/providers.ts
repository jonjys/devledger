// What DevLedger knows about each service it can file by hand: display name,
// logo, and what a key for it looks like.
//
// One registry, so the catalog, the icons and the skill tree all agree. A
// service DevLedger has no built-in provider for is stored as `other:<Name>`.
// That tag must be sent explicitly: the backend turns a bare `unknown` into
// `other:<label>`, so a catalog card that sent `unknown` used to file a
// Cloudflare account under whatever label the user typed -- often an email.

import {
  siClaude,
  siClerk,
  siCloudflare,
  siDigitalocean,
  siDiscord,
  siFirebase,
  siFlydotio,
  siGithub,
  siGmail,
  siGoogle,
  siGooglegemini,
  siHuggingface,
  siLinear,
  siMailgun,
  siMistralai,
  siMongodb,
  siNeon,
  siNetlify,
  siNotion,
  siOpenrouter,
  siPaypal,
  siPlanetscale,
  siPostgresql,
  siRailway,
  siRedis,
  siRender,
  siResend,
  siSentry, // catalog-only: a logo, not an error reporter
  siShopify,
  siStripe,
  siSupabase,
  siUpstash,
  siVercel,
  type SimpleIcon,
} from "simple-icons";

import type { Provider } from "./types";

export interface ProviderInfo {
  /** The tag stored on disk and sent over IPC. */
  provider: Provider;
  name: string;
  summary: string;
  keyPlaceholder: string;
  /** A brand logo, when simple-icons has one. */
  icon: SimpleIcon | null;
  /** Other names a user might type for the same service. */
  aliases?: string[];
  /** Listed on the Connections page. */
  catalog?: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    provider: "supabase",
    name: "Supabase",
    summary: "Postgres projects, auth and storage.",
    keyPlaceholder: "sbp_…",
    icon: siSupabase,
    catalog: true,
  },
  {
    provider: "github",
    name: "GitHub",
    summary: "Repositories, tokens and webhooks.",
    keyPlaceholder: "ghp_…",
    icon: siGithub,
    aliases: ["git_hub"],
    catalog: true,
  },
  {
    provider: "vercel",
    name: "Vercel",
    summary: "Deployments and project settings.",
    keyPlaceholder: "vercel token",
    icon: siVercel,
    catalog: true,
  },
  {
    provider: "stripe",
    name: "Stripe",
    summary: "Billing, customers and payouts.",
    keyPlaceholder: "sk_live_…",
    icon: siStripe,
    catalog: true,
  },
  {
    provider: "openai",
    name: "OpenAI",
    summary: "API usage and keys.",
    keyPlaceholder: "sk-…",
    // simple-icons no longer ships an OpenAI logo; the monogram stands in.
    icon: null,
    aliases: ["open_ai", "chatgpt"],
    catalog: true,
  },
  {
    provider: "anthropic",
    name: "Anthropic",
    summary: "Claude API keys and usage.",
    keyPlaceholder: "sk-ant-…",
    icon: siClaude,
    aliases: ["claude"],
    catalog: true,
  },
  {
    provider: "aws",
    name: "AWS",
    summary: "Access keys and services.",
    keyPlaceholder: "AKIA…",
    icon: null,
    aliases: ["amazon web services"],
    catalog: true,
  },
  {
    provider: "postgres",
    name: "Postgres",
    summary: "Connection strings for any Postgres.",
    keyPlaceholder: "postgresql://…",
    icon: siPostgresql,
    aliases: ["postgresql"],
  },
  other("Neon", "Serverless Postgres and connection strings.", "postgresql://…", siNeon, true),
  other("Resend", "Sending domains and API keys.", "re_…", siResend, true),
  other("Cloudflare", "DNS, workers and API tokens.", "cf token", siCloudflare, true),
  other("Netlify", "Sites and deploy keys.", "nfp_…", siNetlify, true),
  other("Firebase", "Projects and service accounts.", "service account", siFirebase, true),
  other("Railway", "Projects and deploy tokens.", "railway token", siRailway, true),
  other("Render", "Services and API keys.", "rnd_…", siRender, true),
  other("Sentry", "Projects and auth tokens.", "sntrys_…", siSentry, true), // catalog-only
  other("Clerk", "Authentication keys.", "sk_…", siClerk),
  other("Upstash", "Redis and queues.", "token", siUpstash),
  other("PlanetScale", "MySQL databases.", "pscale_…", siPlanetscale),
  other("MongoDB", "Atlas clusters.", "mongodb+srv://…", siMongodb),
  other("Redis", "Databases and keys.", "redis://…", siRedis),
  other("Fly.io", "Apps and deploy tokens.", "fo1_…", siFlydotio),
  other("DigitalOcean", "Droplets and API tokens.", "dop_v1_…", siDigitalocean),
  other("Mailgun", "Email sending keys.", "key-…", siMailgun),
  other("Hugging Face", "Models and access tokens.", "hf_…", siHuggingface),
  other("Mistral", "API keys.", "key", siMistralai),
  other("Gemini", "Google AI keys.", "AIza…", siGooglegemini),
  other("OpenRouter", "Model routing keys.", "sk-or-…", siOpenrouter),
  other("Google", "Google account.", "", siGoogle),
  other("Gmail", "Email account.", "", siGmail),
  other("Notion", "Workspaces and integration tokens.", "secret_…", siNotion),
  other("Linear", "Issues and API keys.", "lin_api_…", siLinear),
  other("Discord", "Bots and webhooks.", "token", siDiscord),
  other("PayPal", "Payments and client secrets.", "client secret", siPaypal),
  other("Shopify", "Stores and admin tokens.", "shpat_…", siShopify),
];

function other(
  name: string,
  summary: string,
  keyPlaceholder: string,
  icon: SimpleIcon | null,
  catalog = false,
): ProviderInfo {
  return { provider: `other:${name}`, name, summary, keyPlaceholder, icon, catalog };
}

const OTHER_PREFIX = "other:";

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/[\s._-]+/g, "");
}

const BY_NAME = new Map<string, ProviderInfo>();
for (const info of PROVIDERS) {
  const bare = info.provider.startsWith(OTHER_PREFIX)
    ? info.provider.slice(OTHER_PREFIX.length)
    : info.provider;
  for (const key of [bare, info.name, ...(info.aliases ?? [])]) {
    BY_NAME.set(normalise(key), info);
  }
}

/** What DevLedger knows about a provider tag, or about a service by name. */
export function providerInfo(providerOrName: Provider | string): ProviderInfo | null {
  const bare = providerOrName.startsWith(OTHER_PREFIX)
    ? providerOrName.slice(OTHER_PREFIX.length)
    : providerOrName;
  if (!bare.trim()) return null;
  return BY_NAME.get(normalise(bare)) ?? null;
}

/**
 * The provider tag for a service name someone typed.
 *
 * "Claude" becomes `anthropic`, "resend" becomes `other:Resend` with the
 * registry's spelling, and a name DevLedger has never heard of becomes
 * `other:<name>` exactly as typed. Never `unknown` for a non-empty name, so the
 * backend cannot rename it.
 */
export function providerForName(name: string): Provider {
  const trimmed = name.trim();
  if (!trimmed) return "unknown";
  return providerInfo(trimmed)?.provider ?? `other:${trimmed}`;
}

/** Services the Connections page offers by hand. */
export function catalogProviders(): ProviderInfo[] {
  return PROVIDERS.filter((p) => p.catalog);
}

/** Every name the registry knows, for type-ahead. */
export function knownServiceNames(): string[] {
  return PROVIDERS.map((p) => p.name);
}
