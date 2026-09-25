import { useState, type KeyboardEvent } from "react";

interface Props {
  onAnalyze: (text: string) => void;
  busy: boolean;
}

/**
 * The global Smart Paste input, styled as the app's top bar.
 *
 * Always present, so anything on the clipboard can be dropped in without
 * navigating first. Ctrl/Cmd+Enter submits.
 */
export default function SmartPasteBar({ onAnalyze, busy }: Props) {
  const [text, setText] = useState("");

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    onAnalyze(trimmed);
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="pastebar">
      <span className="pastebar-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <textarea
        className="pastebar-input"
        aria-label="Smart Paste"
        rows={1}
        title="Nothing is saved until you review it. Ctrl/Cmd + Enter to analyse."
        placeholder="Paste anything — env vars, emails, URLs, receipts, API keys…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="outline analyze"
        onClick={submit}
        disabled={!text.trim() || busy}
      >
        {busy ? "Analysing…" : "Analyze ⏎"}
      </button>
    </div>
  );
}
