import { useEffect, useMemo, useState } from "react";

import * as api from "../lib/api";
import { providerFromInput, providerLabel } from "../lib/format";
import type { Account, Environment, IdentityNode, ProjectSummary } from "../lib/types";
import { FIELD_SUGGESTIONS } from "./FieldsEditor";
import Modal from "./Modal";

/**
 * What a typed word can be.
 *
 * Each kind knows whether its value is sensitive (typed masked, sealed in
 * Rust) and what else it needs to know to land in the right place.
 */
export type WordKind =
  | "project"
  | "email"
  | "service"
  | "username"
  | "login_email"
  | "password"
  | "api_key"
  | "variable"
  | "field";

interface KindInfo {
  label: string;
  hint: string;
  secret: boolean;
  needs: "nothing" | "person" | "account" | "project" | "owner";
  placeholder: string;
}

export const WORD_KINDS: Record<WordKind, KindInfo> = {
  project: {
    label: "Project",
    hint: "Something you build or run.",
    secret: false,
    needs: "nothing",
    placeholder: "Storefront",
  },
  email: {
    label: "Email / person",
    hint: "An address you sign in with. Becomes a person, or joins one.",
    secret: false,
    needs: "nothing",
    placeholder: "you@example.com",
  },
  service: {
    label: "Service account",
    hint: "Any service: Supabase, your bank, a registrar, a forum.",
    secret: false,
    needs: "person",
    placeholder: "Loopia",
  },
  username: {
    label: "Username",
    hint: "The username an account signs in with.",
    secret: false,
    needs: "account",
    placeholder: "acme_dev",
  },
  login_email: {
    label: "Login email",
    hint: "The address an account signs in with, if not the person's own.",
    secret: false,
    needs: "account",
    placeholder: "billing@example.com",
  },
  password: {
    label: "Password",
    hint: "Encrypted in Rust. Shown only with Reveal.",
    secret: true,
    needs: "account",
    placeholder: "••••••••",
  },
  api_key: {
    label: "API key / token",
    hint: "Encrypted in Rust. Shown only with Reveal.",
    secret: true,
    needs: "owner",
    placeholder: "sk_…",
  },
  variable: {
    label: "Env variable",
    hint: "A value for a project's .env, per environment. Encrypted.",
    secret: true,
    needs: "project",
    placeholder: "postgres://…",
  },
  field: {
    label: "Own field",
    hint: "Anything else, under a name you choose.",
    secret: false,
    needs: "owner",
    placeholder: "LP-448812",
  },
};

const ORDER: WordKind[] = [
  "project",
  "email",
  "service",
  "username",
  "login_email",
  "password",
  "api_key",
  "variable",
  "field",
];

interface Props {
  onClose: () => void;
  onDone: () => void;
  onNotify: (message: string, bad?: boolean) => void;
  /** Start with a kind already chosen. */
  initialKind?: WordKind;
}

type AccountOption = Account & { person: string };

/**
 * Add anything by typing it and saying what it is.
 *
 * The answer to "can I just type a word and tell DevLedger it is a project, a
 * username, an email?" -- yes, here, with no token and no paste. Each choice
 * goes through the same backend commands the rest of the app uses; this dialog
 * only decides which one and asks for the one or two things that choice needs.
 */
export default function AddAnythingDialog({ onClose, onDone, onNotify, initialKind }: Props) {
  const [kind, setKind] = useState<WordKind | null>(initialKind ?? null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [graph, setGraph] = useState<IdentityNode[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [personId, setPersonId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [owner, setOwner] = useState("");
  const [environment, setEnvironment] = useState<Environment>("development");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.identityGraph(), api.listProjects()])
      .then(([g, p]) => {
        setGraph(g ?? []);
        setProjects(p ?? []);
      })
      .catch(() => undefined);
  }, []);

  const accounts: AccountOption[] = useMemo(
    () =>
      graph.flatMap((node) =>
        node.accounts.map((a) => ({
          ...a.account,
          person: node.identity.email ?? node.identity.label,
        })),
      ),
    [graph],
  );

  // Sensible defaults once the lists arrive, so the common case is two clicks.
  useEffect(() => {
    if (!personId && graph[0]) setPersonId(graph[0].identity.id);
  }, [graph, personId]);
  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);
  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].project.id);
  }, [projects, projectId]);

  const info = kind ? WORD_KINDS[kind] : null;
  const needsName = kind === "api_key" || kind === "variable" || kind === "field";
  const missingContext =
    !info ||
    (info.needs === "person" && !personId) ||
    (info.needs === "account" && !accountId) ||
    (info.needs === "project" && !projectId) ||
    (info.needs === "owner" && !owner);
  const ready = Boolean(kind) && text.trim() !== "" && !missingContext && (!needsName || name.trim() !== "") && !busy;

  async function submit() {
    if (!ready || !kind) return;
    setBusy(true);
    const value = WORD_KINDS[kind].secret ? text : text.trim();
    try {
      const done = await save(kind, value);
      // A typed secret must not outlive the save in component state.
      setText("");
      onNotify(done);
      onDone();
      onClose();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function save(k: WordKind, value: string): Promise<string> {
    const account = accounts.find((a) => a.id === accountId);
    switch (k) {
      case "project": {
        const p = await api.createProject(value, null);
        return `Added project ${p.name}`;
      }
      case "email": {
        const person = await api.createIdentityManual("", value);
        return `Added ${person.label}`;
      }
      case "service": {
        const provider = providerFromInput(value);
        const created = await api.createAccountManual(personId, provider, providerLabel(provider));
        return `Added ${providerLabel(created.provider)} account`;
      }
      case "username":
      case "login_email": {
        if (!account) throw new Error("Choose an account");
        await api.updateAccount(account.id, account.label, {
          login_email: k === "login_email" ? value : account.login_email,
          username: k === "username" ? value : account.username,
          url: account.url,
          notes: account.notes,
        });
        return `Saved ${k === "username" ? "username" : "login email"} on ${account.label}`;
      }
      case "password": {
        if (!account) throw new Error("Choose an account");
        await api.storeSecret(
          {
            owner: { project_id: null, service_project_id: null, account_id: account.id },
            kind: "password",
            name: "Password",
            environment: "unknown",
            notes: null,
          },
          value,
        );
        return `Stored the password for ${account.label}, encrypted`;
      }
      case "api_key":
      case "field": {
        const [ownerKind, ownerId] = owner.split(":");
        if (!ownerId) throw new Error("Choose where it belongs");
        if (k === "field") {
          const entityKind =
            ownerKind === "account" ? "account" : ownerKind === "project" ? "project" : "identity";
          await api.addCustomField({ kind: entityKind, id: ownerId }, name.trim(), value);
          return `Added ${name.trim()}`;
        }
        await api.storeSecret(
          {
            owner: {
              project_id: ownerKind === "project" ? ownerId : null,
              service_project_id: null,
              account_id: ownerKind === "account" ? ownerId : null,
            },
            kind: "generic_api_key",
            name: name.trim(),
            environment: "unknown",
            notes: null,
          },
          value,
        );
        return `Stored ${name.trim()}, encrypted`;
      }
      case "variable": {
        await api.storeSecret(
          {
            owner: { project_id: projectId, service_project_id: null, account_id: null },
            kind: "env_var",
            name: name.trim(),
            environment,
            notes: null,
          },
          value,
        );
        return `Stored ${name.trim()}, encrypted`;
      }
    }
  }

  const noPeople = graph.length === 0;
  const noAccounts = accounts.length === 0;
  const noProjects = projects.length === 0;

  return (
    <Modal label="Add anything" onClose={onClose} maxWidth={620}>
      <header>
        <h2>Add anything</h2>
        <p>Type it, then say what it is. No token or paste needed.</p>
      </header>
      <form
        className="scroll form-stack add-anything"
        aria-label="Add anything"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="kind-chips" role="radiogroup" aria-label="What is it?">
          {ORDER.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={`chip${kind === k ? " on" : ""}`}
              onClick={() => setKind(k)}
            >
              {WORD_KINDS[k].label}
            </button>
          ))}
        </div>
        {info && <p className="muted kind-hint">{info.hint}</p>}

        {needsName && (
          <label>
            Name
            <input
              aria-label="Name"
              list={kind === "field" ? "add-field-names" : undefined}
              className={kind === "variable" ? "mono" : undefined}
              placeholder={
                kind === "variable" ? "DATABASE_URL" : kind === "api_key" ? "Stripe secret key" : "Customer number"
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <datalist id="add-field-names">
              {FIELD_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
        )}

        <label>
          {info?.secret ? "Value (hidden)" : "Text"}
          <input
            autoFocus
            aria-label="Text"
            type={info?.secret ? "password" : "text"}
            autoComplete="off"
            placeholder={info?.placeholder ?? "Type a word, a name, an address…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {kind === "service" && text.trim() && (
          <p className="muted kind-hint">
            {providerFromInput(text).startsWith("other:")
              ? `Recorded as your own service, "${text.trim()}".`
              : `Recognised as ${providerLabel(providerFromInput(text))}.`}
          </p>
        )}

        {info?.needs === "person" &&
          (noPeople ? (
            <p className="warn-inline">Add a person (Email / person) first.</p>
          ) : (
            <label>
              Whose account
              <select aria-label="Person" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                {graph.map((n) => (
                  <option key={n.identity.id} value={n.identity.id}>
                    {n.identity.email ?? n.identity.label}
                  </option>
                ))}
              </select>
            </label>
          ))}

        {info?.needs === "account" &&
          (noAccounts ? (
            <p className="warn-inline">Add a service account first.</p>
          ) : (
            <label>
              Which account
              <select aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {providerLabel(a.provider)} · {a.label} ({a.person})
                  </option>
                ))}
              </select>
            </label>
          ))}

        {info?.needs === "project" &&
          (noProjects ? (
            <p className="warn-inline">Add a project first.</p>
          ) : (
            <>
              <label>
                Which project
                <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.project.id} value={p.project.id}>
                      {p.project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Environment
                <select
                  aria-label="Environment"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as Environment)}
                >
                  <option value="development">Development</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                  <option value="unknown">Unassigned</option>
                </select>
              </label>
            </>
          ))}

        {info?.needs === "owner" && (
          <label>
            Belongs to
            <select aria-label="Belongs to" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Choose…</option>
              {kind === "field" && graph.length > 0 && (
                <optgroup label="People">
                  {graph.map((n) => (
                    <option key={n.identity.id} value={`identity:${n.identity.id}`}>
                      {n.identity.email ?? n.identity.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {accounts.length > 0 && (
                <optgroup label="Accounts">
                  {accounts.map((a) => (
                    <option key={a.id} value={`account:${a.id}`}>
                      {providerLabel(a.provider)} · {a.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {projects.length > 0 && (
                <optgroup label="Projects">
                  {projects.map((p) => (
                    <option key={p.project.id} value={`project:${p.project.id}`}>
                      {p.project.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}

        <div className="row-acts">
          <button type="submit" className="primary" disabled={!ready}>
            {info?.secret ? "Store encrypted" : "Add"}
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
