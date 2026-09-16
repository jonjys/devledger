import { useState, type KeyboardEvent } from "react";

interface Props {
  onAnalyze: (text: string) => void;
  busy: boolean;
}

/**
 * The global Smart Paste input.
 *
 * Always present above the shell, so anything on the clipboard can be dropped
 * in without navigating first. Ctrl/Cmd+Enter submits.
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
    <div className="paste-wrap">
      <textarea
        aria-label="Smart Paste"
        placeholder="Paste a .env block, a Supabase URL, a connection string, a billing page…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="paste-row">
        <span className="hint">
          Nothing is saved until you review it. Ctrl/Cmd + Enter to analyse.
        </span>
        <button type="button" className="primary" onClick={submit} disabled={!text.trim() || busy}>
          {busy ? "Analysing…" : "Analyse"}
        </button>
      </div>
    </div>
  );
}
