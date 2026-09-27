// What a paste looks like it contains, said before it is sent for analysis.
//
// These are hints for the person pasting, nothing more: the backend's Smart
// Paste pipeline is what actually decides what each line is. Nothing here
// keeps the text; it returns labels and counts only.

export interface PasteHint {
  label: string;
  count: number;
}

const RULES: { label: string; pattern: RegExp }[] = [
  { label: "Resend API key", pattern: /\b(?:re|resend)_[A-Za-z0-9_]{8,}/g },
  { label: "Stripe secret key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { label: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { label: "OpenAI key", pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}/g },
  { label: "JWT / Supabase key", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { label: "Postgres URL", pattern: /\bpostgres(?:ql)?:\/\/\S+/g },
  { label: "email address", pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
];

/** `.env`-style lines: KEY=value, optionally with `export`. */
const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/gm;

export function pasteHints(text: string): PasteHint[] {
  const hints: PasteHint[] = [];
  const env = text.match(ENV_LINE)?.length ?? 0;
  if (env > 0) hints.push({ label: env === 1 ? ".env variable" : ".env variables", count: env });
  for (const rule of RULES) {
    const count = text.match(rule.pattern)?.length ?? 0;
    if (count > 0) hints.push({ label: rule.label, count });
  }
  return hints;
}
