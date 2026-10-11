// The browser demo's copy of the assistant outline (the desktop app builds it in
// Rust, in devledger-core's assistant module). Same rules: names and
// relationships only, never a value or a preview, never a note or a custom
// field, and every email address swapped for a placeholder that is put back
// in the answer locally.

import { providerLabel } from "../../lib/format";
import type {
  AttentionItem,
  LedgerIdentity,
  ProjectSummary,
  SecretListing,
  ServiceProjectSummary,
  SubscriptionSummary,
} from "../../lib/types";

export interface OutlineInput {
  people: LedgerIdentity[];
  projects: ProjectSummary[];
  resources: ServiceProjectSummary[];
  secrets: SecretListing[];
  subscriptions: SubscriptionSummary[];
  worksOn: [string, string][];
  attention: AttentionItem[];
}

export type DemoTask = { task: "review" } | { task: "leak"; secretId: string } | { task: "ask"; question: string };

export interface PreparedOutline {
  user: string;
  placeholders: [string, string][];
}

export const MAX_QUESTION = 1000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEYLIKE = /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|eyJ)[-_A-Za-z0-9.]{12,}/g;

const oneLine = (text: string, max: number) => {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

const LANGUAGES: Record<string, string> = {
  sv: "Swedish",
  no: "Norwegian",
  nb: "Norwegian",
  nn: "Norwegian",
  da: "Danish",
  fi: "Finnish",
  de: "German",
  fr: "French",
  es: "Spanish",
  nl: "Dutch",
};

const KIND_LABEL: Record<string, string> = {
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

export function buildOutline(input: OutlineInput, task: DemoTask, language: string): PreparedOutline {
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  const id = (prefix: string, key: string) => {
    const known = ids.get(key);
    if (known) return known;
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    const made = `${prefix}${n}`;
    ids.set(key, made);
    return made;
  };

  const lines: string[] = ["# Ledger outline (names and relationships only)", "", "## People and what they hold"];
  const resourceLine = (r: ServiceProjectSummary, indent: string) => {
    const sp = r.service_project;
    let line = `${indent}- ${id("R", sp.id)} ${providerLabel(sp.provider)} resource "${oneLine(sp.name, 80)}" [${sp.environment}]`;
    if (sp.region) line += `, region ${oneLine(sp.region, 30)}`;
    if (r.secret_count > 0) line += `, holds ${r.secret_count} key(s)`;
    line += r.used_by.length
      ? `, used by ${r.used_by.map((p) => `"${oneLine(p.name, 60)}"`).join(", ")}`
      : ", used by no project";
    lines.push(line);
  };
  for (const person of input.people) {
    const pid = id("P", person.identity.id);
    const addresses = person.emails.map((e) => (e.is_primary ? `${e.address} (primary)` : e.address));
    lines.push(
      "",
      `### ${pid} "${oneLine(person.identity.label, 80)}"${addresses.length ? ` — ${addresses.join(", ")}` : " — no email recorded"}`,
    );
    for (const node of person.accounts) {
      const a = node.account;
      let line = `- ${id("A", a.id)} ${providerLabel(a.provider)} account "${oneLine(a.label, 80)}" (held by ${pid})`;
      if (a.login_email) line += `, signs in with ${a.login_email}`;
      if (a.username) line += `, username ${oneLine(a.username, 40)}`;
      lines.push(line);
      for (const org of node.organizations) {
        lines.push(`  - ${id("O", org.organization.id)} organization "${oneLine(org.organization.name, 80)}"`);
        for (const r of org.service_projects) resourceLine(r, "    ");
      }
      for (const r of node.unassigned) resourceLine(r, "  ");
      for (const s of node.subscriptions) {
        const price =
          s.amount_cents == null
            ? "no price recorded"
            : `${(s.amount_cents / 100).toFixed(2)} ${s.currency ?? ""}`.trim() +
              (s.interval === "yearly" ? " per year" : " per month");
        let sl = `  - subscription "${oneLine(s.plan, 60)}": ${price}, ${s.status}`;
        if (s.trial_ends_at) sl += `, trial/renewal date ${oneLine(s.trial_ends_at, 30)}`;
        lines.push(sl);
      }
    }
  }

  lines.push("", "## Projects");
  for (const p of input.projects) {
    const used = input.resources
      .filter((r) => r.used_by.some((u) => u.id === p.project.id))
      .map((r) => `${id("R", r.service_project.id)} ${providerLabel(r.service_project.provider)} "${oneLine(r.service_project.name, 60)}"`);
    const people = input.worksOn.filter(([, proj]) => proj === p.project.id).map(([who]) => ids.get(who)).filter(Boolean);
    let line = `- ${id("J", p.project.id)} project "${oneLine(p.project.name, 80)}"`;
    if (p.project.description?.trim()) line += ` — ${oneLine(p.project.description, 200)}`;
    line += used.length ? `; uses ${used.join(", ")}` : "; uses no recorded service";
    if (people.length) line += `; worked on by ${people.join(", ")}`;
    line += `; ${p.secret_count} key(s) reachable`;
    lines.push(line);
  }

  lines.push("", "## Keys and variables (names only; values never leave the vault)");
  for (const { entry, owner } of input.secrets) {
    const s = entry.secret;
    let line = `- ${id("K", s.id)} ${oneLine(s.name, 80)} — ${KIND_LABEL[s.kind] ?? s.kind}, ${s.environment}, ${
      entry.client_unsafe ? "server-only" : "safe in client code"
    }, belongs to ${oneLine(owner, 100)}`;
    if (s.service_project_id && ids.has(s.service_project_id)) line += ` (${ids.get(s.service_project_id)})`;
    line += `, last changed ${s.updated_at.slice(0, 10)}`;
    lines.push(line);
  }

  lines.push("", "## Monthly cost (recorded plans; yearly spread over 12)");
  const now = new Map<string, number>();
  const trials = new Map<string, number>();
  for (const { subscription: sub } of input.subscriptions) {
    if (sub.amount_cents == null) continue;
    const monthly = sub.interval === "yearly" ? sub.amount_cents / 12 : sub.amount_cents;
    const cur = (sub.currency ?? "").toUpperCase();
    if (["active", "past_due", "unknown"].includes(sub.status)) now.set(cur, (now.get(cur) ?? 0) + monthly);
    else if (sub.status === "trialing") trials.set(cur, (trials.get(cur) ?? 0) + monthly);
  }
  for (const [cur, cents] of now) lines.push(`- paying now: ${(cents / 100).toFixed(2)} ${cur} per month`.replace("  ", " "));
  for (const [cur, cents] of trials)
    lines.push(`- trials that will start charging: ${(cents / 100).toFixed(2)} ${cur} per month`.replace("  ", " "));
  if (!now.size && !trials.size) lines.push("(no priced subscriptions)");

  lines.push("", "## Gaps DevLedger already flagged");
  if (!input.attention.length) lines.push("(none)");
  for (const item of input.attention) lines.push(`- ${oneLine(item.title, 160)}`);

  let instruction: string;
  if (task.task === "review") {
    instruction = `## Task
Review this setup. Report, most important first:
1. Security risks: server-only keys that look exposed to client code (for example a NEXT_PUBLIC_ or VITE_ name on a server-only key), production keys shared between projects, keys on resources no project uses, keys not changed in a long time, production running on an account that only one personal address can reach.
2. Gaps that make the map wrong or incomplete.
3. Money: overlapping or unused subscriptions, trials about to start charging, and what could be saved per month. Use only the prices in the outline.
For each finding: what it is, why it matters, the fix. End with a section "Do this first" with at most three items. If the setup looks healthy, say so plainly and keep it short.`;
  } else if (task.task === "leak") {
    const listing = input.secrets.find((s) => s.entry.secret.id === task.secretId);
    if (!listing) throw new Error("choose the key that leaked");
    instruction = `## Task
The key ${id("K", task.secretId)} (${listing.entry.secret.name}, ${KIND_LABEL[listing.entry.secret.kind] ?? listing.entry.secret.kind}) has leaked, for example pushed to a public repository or pasted somewhere public. Write a rotation plan:
1. Revoke or roll it at the provider: say where in that provider's dashboard, if you know.
2. Create the replacement.
3. Every place in this ledger that depends on it: the resource, the projects that use that resource, the environments, and any other keys on the same resource that should be rotated with it.
4. What to check afterwards: access logs, unusual usage, billing.
5. One or two habits that would have prevented it.
Say where you are unsure about a provider's screens rather than guessing.`;
  } else {
    const q = task.question.trim();
    if (!q) throw new Error("ask the assistant something");
    if (q.length > MAX_QUESTION) throw new Error(`keep the question under ${MAX_QUESTION} characters`);
    instruction = `## Question\n${q}`;
  }

  // A key pasted into a question or a label is cut out, like the app's own sweep.
  instruction = instruction.replace(KEYLIKE, "[REDACTED]");

  const lang = LANGUAGES[language.split("-")[0]?.toLowerCase() ?? ""] ?? "English";
  const raw = `${lines.join("\n")}\n\n${instruction}\n\nAnswer in ${lang}.`;

  // Addresses last, so one in a label or a question is caught too.
  const byAddress = new Map<string, string>();
  const placeholders: [string, string][] = [];
  const user = raw.replace(EMAIL, (address) => {
    const key = address.toLowerCase();
    const known = byAddress.get(key);
    if (known) return known;
    const placeholder = `<email-${placeholders.length + 1}>`;
    byAddress.set(key, placeholder);
    placeholders.push([placeholder, address]);
    return placeholder;
  });
  return { user, placeholders };
}

/** Put the real addresses back, longest placeholder first. */
export function restore(answer: string, placeholders: [string, string][]): string {
  return [...placeholders]
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((text, [p, real]) => text.split(p).join(real), answer);
}
