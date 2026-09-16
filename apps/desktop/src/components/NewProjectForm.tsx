import { useState, type FormEvent } from "react";

import * as api from "../lib/api";

interface Props {
  onCreated: (projectId: string) => void;
  onNotify: (message: string, bad?: boolean) => void;
}

/**
 * Create a DevLedger project by hand.
 *
 * Smart Paste is the usual route, but a project often exists in someone's head
 * before any credential does, and linking resources to it later is easier than
 * remembering to name it mid-paste.
 */
export default function NewProjectForm({ onCreated, onNotify }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const project = await api.createProject(trimmed, description.trim() || null);
      setName("");
      setDescription("");
      setOpen(false);
      onNotify(`Created ${project.name}`);
      onCreated(project.id);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>
        + New project
      </button>
    );
  }

  return (
    <form className="new-project" onSubmit={submit}>
      <input
        autoFocus
        value={name}
        placeholder="Project name"
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <input
        value={description}
        placeholder="What is it? (optional)"
        aria-label="Project description"
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="row">
        <button type="submit" className="primary" disabled={!name.trim() || busy}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
