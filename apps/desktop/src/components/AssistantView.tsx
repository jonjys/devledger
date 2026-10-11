import { useCallback, useEffect, useMemo, useState } from "react";

import * as api from "../lib/api";
import type { AssistantRequest } from "../lib/api";
import { Markdown } from "../lib/markdown";
import type { AssistantAnswer, AssistantPreview, AssistantStatus, SecretListing } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  /** A key to plan a rotation for, when the user came here from that key. */
  leakSecretId?: string | null;
}

const KEY_URL = "https://console.anthropic.com/settings/keys";

/** Shown while the model works: it thinks before it writes, so this takes a moment. */
function Thinking({ label }: { label: string }) {
  return (
    <div className="ai-thinking" role="status">
      <span className="ai-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </div>
  );
}

function SetUp({ onDone, onNotify }: { onDone: (s: AssistantStatus) => void; onNotify: Props["onNotify"] }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      onDone(await api.assistantSetKey(key));
      setKey("");
      onNotify("Assistant switched on");
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card ai-setup">
      <h3>Switch on the assistant</h3>
      <p>
        It uses your own Anthropic API key, so you pay Anthropic directly for what you use, usually a few
        cents per answer. Create one at{" "}
        <a href={KEY_URL} target="_blank" rel="noreferrer">
          console.anthropic.com
        </a>
        .
      </p>
      <form
        className="ai-key-row"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          aria-label="Anthropic API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save key"}
        </button>
      </form>
      <p className="ai-fine">
        DevLedger checks the key with one request to Anthropic, then seals it in your vault like any other
        secret. It is never shown again and never leaves the app except to talk to Anthropic.
      </p>
    </section>
  );
}

function Sent({ preview }: { preview: AssistantPreview }) {
  return (
    <div className="ai-sent">
      <p>
        This is everything that would be sent: names and connections only. No key values, no previews of
        them, and {preview.addresses_hidden} email address{preview.addresses_hidden === 1 ? "" : "es"} replaced
        with placeholders that are swapped back on your machine.
      </p>
      <pre>{preview.user}</pre>
    </div>
  );
}

/**
 * The AI assistant: a security and cost review of the whole setup, a rotation
 * plan for a leaked key, or any question about what is connected to what.
 */
export default function AssistantView({ onNotify, leakSecretId }: Props) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [secrets, setSecrets] = useState<SecretListing[]>([]);
  const [leakId, setLeakId] = useState<string>(leakSecretId ?? "");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ title: string; result: AssistantAnswer } | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: AssistantPreview } | null>(null);

  useEffect(() => {
    api
      .assistantStatus()
      .then(setStatus)
      .catch((e: unknown) => onNotify(e instanceof Error ? e.message : String(e), true));
    api
      .listAllSecrets()
      .then(setSecrets)
      .catch(() => setSecrets([]));
  }, [onNotify]);

  useEffect(() => {
    if (leakSecretId) setLeakId(leakSecretId);
  }, [leakSecretId]);

  const leakName = useMemo(
    () => secrets.find((s) => s.entry.secret.id === leakId)?.entry.secret.name ?? "",
    [secrets, leakId],
  );

  const run = useCallback(
    async (key: string, title: string, request: AssistantRequest) => {
      setBusy(key);
      setAnswer(null);
      try {
        setAnswer({ title, result: await api.assistantAsk(request) });
      } catch (e: unknown) {
        onNotify(e instanceof Error ? e.message : String(e), true);
      } finally {
        setBusy(null);
      }
    },
    [onNotify],
  );

  const showSent = useCallback(
    async (key: string, request: AssistantRequest) => {
      if (preview?.key === key) {
        setPreview(null);
        return;
      }
      try {
        setPreview({ key, data: await api.assistantPreview(request) });
      } catch (e: unknown) {
        onNotify(e instanceof Error ? e.message : String(e), true);
      }
    },
    [preview, onNotify],
  );

  async function switchOff() {
    if (!window.confirm("Remove the API key? The assistant stops working until you add one again.")) return;
    try {
      setStatus(await api.assistantClearKey());
      setAnswer(null);
      onNotify("Assistant switched off");
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  const review: AssistantRequest = { task: "review" };
  const leak: AssistantRequest = { task: "leak", secretId: leakId || null };
  const ask: AssistantRequest = { task: "ask", question };

  return (
    <div className="ai">
      <div className="vault-head">
        <div>
          <h1>
            Assistant <span className="ai-badge">AI</span>
          </h1>
          <div className="sub">
            Ask about your setup. Only names and connections are sent: never a key, never your email
            addresses.
          </div>
        </div>
      </div>

      {status === null ? (
        <div className="empty">Loading…</div>
      ) : !status.enabled ? (
        <SetUp onDone={setStatus} onNotify={onNotify} />
      ) : (
        <>
          <div className="ai-grid">
            <section className="card ai-card">
              <h3>Review my setup</h3>
              <p>Security risks, gaps in the map, and what you could stop paying for. Most important first.</p>
              <div className="ai-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void run("review", "Review of your setup", review)}
                >
                  Review now
                </button>
                <button type="button" className="ghost" onClick={() => void showSent("review", review)}>
                  {preview?.key === "review" ? "Hide what is sent" : "What is sent?"}
                </button>
              </div>
              {preview?.key === "review" && <Sent preview={preview.data} />}
            </section>

            <section className="card ai-card">
              <h3>A key leaked</h3>
              <p>A step-by-step rotation plan: where to revoke it, and every project and environment that uses it.</p>
              <select aria-label="The key that leaked" value={leakId} onChange={(e) => setLeakId(e.target.value)}>
                <option value="">Choose a key…</option>
                {secrets.map((s) => (
                  <option key={s.entry.secret.id} value={s.entry.secret.id}>
                    {s.entry.secret.name} · {s.owner}
                  </option>
                ))}
              </select>
              <div className="ai-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null || !leakId}
                  onClick={() => void run("leak", `If ${leakName} leaked`, leak)}
                >
                  Make a plan
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!leakId}
                  onClick={() => void showSent("leak", leak)}
                >
                  {preview?.key === "leak" ? "Hide what is sent" : "What is sent?"}
                </button>
              </div>
              {preview?.key === "leak" && <Sent preview={preview.data} />}
            </section>
          </div>

          <section className="card ai-card ai-ask">
            <h3>Ask anything</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim()) void run("ask", question.trim(), ask);
              }}
            >
              <textarea
                aria-label="Your question"
                placeholder="Which projects break if I delete my old Vercel account? What am I paying for twice?"
                maxLength={1000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && question.trim()) {
                    e.preventDefault();
                    void run("ask", question.trim(), ask);
                  }
                }}
              />
              <div className="ai-actions">
                <button type="submit" className="primary" disabled={busy !== null || !question.trim()}>
                  Ask
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!question.trim()}
                  onClick={() => void showSent("ask", ask)}
                >
                  {preview?.key === "ask" ? "Hide what is sent" : "What is sent?"}
                </button>
              </div>
            </form>
            {preview?.key === "ask" && <Sent preview={preview.data} />}
          </section>

          {busy && <Thinking label="Thinking it through… this can take up to a minute." />}

          {answer && (
            <section className="card ai-answer" aria-live="polite">
              <div className="ai-answer-head">
                <h2>{answer.title}</h2>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(answer.result.text);
                    onNotify("Answer copied");
                  }}
                >
                  Copy
                </button>
              </div>
              <Markdown source={answer.result.text} />
              {answer.result.truncated && <p className="ai-fine">The answer was cut short. Ask a narrower question for the rest.</p>}
              <p className="ai-fine">
                {answer.result.model} · {answer.result.input_tokens.toLocaleString()} tokens in,{" "}
                {answer.result.output_tokens.toLocaleString()} out · Check anything important before acting on it.
              </p>
            </section>
          )}

          <p className="ai-foot">
            Using your Anthropic key with {status.model}.{" "}
            <button type="button" className="link" onClick={() => void switchOff()}>
              Remove key
            </button>
          </p>
        </>
      )}
    </div>
  );
}
