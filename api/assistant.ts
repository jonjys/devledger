// The website's AI assistant (the demo and the web app), as a Vercel function.
//
// The demo (invented sample data) and the web app (the visitor's own vault)
// both run entirely in the browser. To let visitors use the assistant without
// an API key of their own, this function holds DevLedger's key
// (ANTHROPIC_API_KEY, set in the Vercel project) and forwards one outline per
// request to Claude. The browser builds that outline the way the desktop app
// does: names and relationships only, no key values or previews, and email
// addresses replaced by placeholders before it leaves the page.
//
// It is built to be hard to misuse as a free general-purpose proxy:
// - It only accepts an outline in the shape the demo builds ("# Ledger
//   outline ..."), capped in size, and it supplies its own fixed instructions.
// - Visitors are rate-limited per address, and the whole function per hour.
//   The counters live in this function instance's memory, so they bound each
//   warm instance rather than the whole deployment; the spend limit on the
//   Anthropic account is the hard ceiling behind them.
// - Answers are kept short and the model's effort is set low, so a request
//   stays cheap and quick.
//
// The desktop app never calls this: it talks to Anthropic directly with the
// user's own key, sealed in their vault.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_OUTLINE = 30_000;
const PER_VISITOR = { limit: 6, windowMs: 10 * 60_000 };
const PER_HOUR = 300;

// Same instructions as the desktop app's (devledger-core, assistant.rs), plus
// one line for the web version (the demo and the web app).
const SYSTEM_PROMPT = `You are DevLedger's assistant. DevLedger is a local, encrypted ledger of a developer's accounts, services, projects, API keys and subscriptions.

You are given an outline of the user's ledger. It holds names and relationships only: no key values, no passwords and no previews of them. Email addresses are replaced by placeholders such as <email-1>; keep them exactly as written, because DevLedger puts the real addresses back before the user reads your answer.

How to answer:
- Work from the outline and from what you know about the services it names. If something is not in the outline, say you cannot see it rather than guessing.
- Never ask for a key, password or token, and never ask the user to paste one. If one appears anyway, do not repeat it.
- Refer to things by their names. The short ids in the outline (P1, A2, K3...) are for you only.
- Be concrete and brief: most important first, numbered steps or short bullets. Use Markdown headings (##), bullets, numbered lists and **bold**; no tables, no HTML, no code blocks longer than a few lines.
- Where DevLedger itself helps, say how: "Replace value" on a key rotates it in the vault, "Copy .env" exports a project's variables for one environment, the map shows what depends on what, and Needs attention lists the gaps.
- Prices come from the outline. Do not invent prices you were not given.

This is the web version. Keep the whole answer under 350 words.`;

const visitors = new Map<string, number[]>();
let hourStart = Date.now();
let hourCount = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function allowed(visitor: string): boolean {
  const now = Date.now();
  if (now - hourStart > 3_600_000) {
    hourStart = now;
    hourCount = 0;
  }
  if (hourCount >= PER_HOUR) return false;
  const recent = (visitors.get(visitor) ?? []).filter((t) => now - t < PER_VISITOR.windowMs);
  if (recent.length >= PER_VISITOR.limit) {
    visitors.set(visitor, recent);
    return false;
  }
  recent.push(now);
  visitors.set(visitor, recent);
  hourCount += 1;
  return true;
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(503, {
      error: "The live AI demo is not switched on yet. In the desktop app the assistant works with your own Anthropic key.",
    });
  }

  let task: unknown;
  let user: unknown;
  try {
    ({ task, user } = (await request.json()) as { task?: unknown; user?: unknown });
  } catch {
    return json(400, { error: "Send JSON." });
  }
  if (!["review", "leak", "ask"].includes(String(task))) return json(400, { error: "Unknown task." });
  if (typeof user !== "string" || !user.startsWith("# Ledger outline") || user.length > MAX_OUTLINE) {
    return json(400, { error: "The demo only answers questions about its own sample ledger." });
  }

  const visitor = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  if (!allowed(visitor)) {
    return json(429, {
      error: "The demo assistant is busy, or you have asked a lot in a short time. Try again in a few minutes.",
    });
  }

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      // A cost ceiling per request, with room to spare: the answer is asked to
      // stay under 350 words (~500 tokens) and effort is low, so thinking is
      // short. A cut-off answer comes back flagged as truncated.
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") {
      return json(422, { error: "The assistant declined to answer this one. Try asking it differently." });
    }
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n\n");
    if (!text.trim()) return json(502, { error: "The assistant returned an empty answer. Try again." });
    return json(200, {
      text,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      truncated: response.stop_reason === "max_tokens",
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return json(429, { error: "The demo assistant is busy. Try again in a minute." });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return json(503, { error: "The live AI demo is misconfigured right now. The desktop app is unaffected." });
    }
    if (error instanceof Anthropic.APIError) {
      return json(502, { error: `The assistant is unavailable right now (${error.status ?? "network"}).` });
    }
    return json(500, { error: "Something went wrong reaching the assistant." });
  }
}
