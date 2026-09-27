// Display helpers. Nothing here ever receives a secret value.

import type { Environment, KnownProvider, Provider, SecretKind, Severity } from "./types";

// Human-readable provider names, keyed by the canonical tag that crosses IPC.
const PROVIDER_LABELS: Record<KnownProvider, string> = {
  supabase: "Supabase",
  postgres: "Postgres",
  github: "GitHub",
  stripe: "Stripe",
  openai: "OpenAI",
  aws: "AWS",
  vercel: "Vercel",
  anthropic: "Anthropic",
  unknown: "Unknown",
};

// Spellings an older build sent. Still accepted so nothing renders as a raw tag.
const LEGACY_PROVIDER_TAGS: Record<string, KnownProvider> = {
  git_hub: "github",
  open_ai: "openai",
};

const OTHER_PREFIX = "other:";

/** Display name for a provider, including a service the user named themselves. */
export function providerLabel(provider: Provider | string): string {
  if (provider.startsWith(OTHER_PREFIX)) {
    return provider.slice(OTHER_PREFIX.length) || "Unknown";
  }
  const known = (LEGACY_PROVIDER_TAGS[provider] ?? provider) as KnownProvider;
  return PROVIDER_LABELS[known] ?? provider;
}

/** Whether this is a service DevLedger has no built-in knowledge of. */
export function isCustomProvider(provider: Provider | string): boolean {
  return provider.startsWith(OTHER_PREFIX);
}

/**
 * The provider tag for what a user typed as a service name.
 *
 * Mirrors the backend's `Provider::from_user_input`: a name DevLedger knows, in
 * any case, becomes that provider, so typing "Supabase" by hand and connecting
 * through the connector land on the same thing. Anything else is `other:<name>`.
 */
export function providerFromInput(text: string): Provider {
  const trimmed = text.trim();
  if (!trimmed) return "unknown";
  const lowered = trimmed.toLowerCase();
  const aliases: Record<string, KnownProvider> = {
    supabase: "supabase",
    postgres: "postgres",
    postgresql: "postgres",
    github: "github",
    git_hub: "github",
    stripe: "stripe",
    openai: "openai",
    open_ai: "openai",
    aws: "aws",
    "amazon web services": "aws",
    vercel: "vercel",
    anthropic: "anthropic",
  };
  return aliases[lowered] ?? `other:${trimmed}`;
}

const SECRET_KIND_LABELS: Record<SecretKind, string> = {
  supabase_anon_key: "Supabase anon key",
  supabase_service_role_key: "Supabase service_role key",
  postgres_connection_string: "Postgres connection string",
  jwt_secret: "JWT secret",
  github_token: "GitHub token",
  stripe_secret_key: "Stripe secret key",
  openai_api_key: "OpenAI API key",
  aws_access_key_id: "AWS access key id",
  aws_secret_access_key: "AWS secret access key",
  generic_api_key: "API key",
  password: "Password",
  env_var: "Environment variable",
};

export function secretKindLabel(kind: SecretKind | null): string {
  return kind ? SECRET_KIND_LABELS[kind] : "Value";
}

export function environmentLabel(environment: Environment): string {
  switch (environment) {
    case "development":
      return "Development";
    case "staging":
      return "Staging";
    case "production":
      return "Production";
    case "unknown":
      return "";
  }
}

/** Like `environmentLabel`, but never empty: an unassigned value says so. */
export function environmentName(environment: Environment): string {
  return environmentLabel(environment) || "Unassigned";
}

export function severityRank(severity: Severity): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

/** Format an RFC 3339 timestamp for display, falling back to the raw string. */
export function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human-readable count, e.g. `1 secret` / `3 secrets`. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count} ${word}`;
}

/** Kinds whose label is generic, so a secret's own name is what tells it apart. */
const GENERIC_SECRET_KINDS = new Set<SecretKind>(["env_var", "generic_api_key", "password"]);

/**
 * The headline and sub-line for a secret row.
 *
 * Indie mode leads with a friendly kind ("Stripe secret key") where the kind
 * says something. Where it does not -- a row of "Environment variable"s, or
 * several "Password"s -- the name leads instead, because otherwise the rows are
 * indistinguishable.
 */
export function secretHeadline(
  kind: SecretKind,
  name: string,
  dev: boolean,
): { title: string; sub: string | null } {
  if (dev || GENERIC_SECRET_KINDS.has(kind)) return { title: name, sub: null };
  return { title: secretKindLabel(kind), sub: name };
}

/** What the Kind column shows: the provider when known, never the word "Unknown". */
export function secretKindColumn(kind: SecretKind, provider: Provider, dev: boolean): string {
  if (dev || provider === "unknown") return secretKindLabel(kind);
  return providerLabel(provider);
}
