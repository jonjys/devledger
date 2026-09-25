// Display helpers. Nothing here ever receives a secret value.

import type { Environment, Provider, SecretKind, Severity } from "./types";

// Human-readable provider names. The keys are the serde snake_case tags that
// cross IPC, so `git_hub` and `open_ai` render as "GitHub" and "OpenAI".
const PROVIDER_LABELS: Record<Provider, string> = {
  supabase: "Supabase",
  postgres: "Postgres",
  git_hub: "GitHub",
  stripe: "Stripe",
  open_ai: "OpenAI",
  aws: "AWS",
  vercel: "Vercel",
  anthropic: "Anthropic",
  unknown: "Unknown",
};

export function providerLabel(provider: Provider): string {
  return PROVIDER_LABELS[provider] ?? provider;
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
