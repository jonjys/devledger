import { useEffect, useMemo, useState } from "react";

import * as api from "../lib/api";
import type {
  Environment,
  IdentityNode,
  ProjectSummary,
  Provider,
  ServiceProjectSummary,
} from "../lib/types";

export type AddKind = "identity" | "account" | "resource" | "secret";

interface Props {
  kind: AddKind;
  graph: IdentityNode[];
  projects: ProjectSummary[];
  presetService?: string | null;
  presetProvider?: Provider | null;
  onClose: () => void;
  onCreated: () => void;
  onNotify: (message: string, bad?: boolean) => void;
}

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "supabase", label: "Supabase" },
  { value: "git_hub", label: "GitHub" },
  { value: "vercel", label: "Vercel" },
  { value: "stripe", label: "Stripe" },
  { value: "open_ai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "aws", label: "AWS" },
  { value: "postgres", label: "Postgres" },
  { value: "unknown", label: "Custom / other" },
];

export default function QuickAddDialog({
  kind,
  graph,
  projects,
  presetService,
  presetProvider,
  onClose,
  onCreated,
  onNotify,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState(presetService ?? "");
  const [email, setEmail] = useState("");
  const [identityId, setIdentityId] = useState(graph[0]?.identity.id ?? "");
  const [provider, setProvider] = useState<Provider>(presetProvider ?? "unknown");
  const [accountId, setAccountId] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [providerRef, setProviderRef] = useState("");
  const [environment, setEnvironment] = useState<Environment>("unknown");
  const [secretTarget, setSecretTarget] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [resources, setResources] = useState<ServiceProjectSummary[]>([]);

  const accounts = useMemo(
    () =>
      graph.flatMap((identity) =>
        identity.accounts.map((account) => ({
          ...account.account,
          identity: identity.identity.email ?? identity.identity.label,
          organizations: account.organizations.map((o) => o.organization),
        })),
      ),
    [graph],
  );

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts]);

  useEffect(() => {
    if (kind !== "secret") return;
    api.listServiceProjects().then(setResources).catch(() => setResources([]));
  }, [kind]);

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const title =
    kind === "identity"
      ? "Add identity"
      : kind === "account"
        ? "Add service account"
        : kind === "resource"
          ? "Add provider resource"
          : "Add API / secret";

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === "identity") {
        await api.createIdentityManual(label.trim() || email.trim(), email.trim() || null);
      } else if (kind === "account") {
        if (!identityId) throw new Error("Choose an identity first");
        await api.createAccountManual(identityId, provider, label.trim());
      } else if (kind === "resource") {
        if (!accountId) throw new Error("Choose an account first");
        await api.createServiceProjectManual(
          accountId,
          organizationId || null,
          selectedAccount?.provider ?? provider,
          label.trim(),
          providerRef.trim() || null,
          environment,
        );
      } else {
        if (!secretTarget) throw new Error("Choose where this API key belongs");
        const [targetKind, id] = secretTarget.split(":");
        if (!id) throw new Error("Invalid secret target");
        await api.createManualSecret(
          targetKind === "project" ? id : null,
          targetKind === "resource" ? id : null,
          label.trim(),
          environment,
          secretValue,
        );
        setSecretValue("");
      }
      onNotify(`${title.replace("Add ", "")} added`);
      onCreated();
      onClose();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    kind === "identity"
      ? Boolean(label.trim() || email.trim())
      : kind === "account"
        ? Boolean(identityId && label.trim())
        : kind === "resource"
          ? Boolean(accountId && label.trim())
          : Boolean(secretTarget && label.trim() && secretValue);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet quick-add">
        <header>
          <h2>{title}</h2>
          <p>Fast entry. You can connect or correct relationships from the stack later.</p>
        </header>
        <div className="scroll form-stack">
          {kind === "identity" && (
            <>
              <label>
                Email
                <input
                  autoFocus
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Label <span className="muted">(optional)</span>
                <input
                  placeholder="Work, Personal…"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
            </>
          )}

          {kind === "account" && (
            <>
              <label>
                Identity
                <select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
                  <option value="">Choose identity…</option>
                  {graph.map((node) => (
                    <option key={node.identity.id} value={node.identity.id}>
                      {node.identity.email ?? node.identity.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Service
                <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Account label
                <input
                  autoFocus
                  placeholder={presetService ? `${presetService} account` : "Account name or email"}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {provider === "unknown" && presetService && (
                <div className="note">
                  {presetService} is stored as a custom service account until a native connector exists.
                </div>
              )}
            </>
          )}

          {kind === "resource" && (
            <>
              <label>
                Service account
                <select
                  value={accountId}
                  onChange={(e) => {
                    setAccountId(e.target.value);
                    setOrganizationId("");
                  }}
                >
                  <option value="">Choose account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.identity} · {a.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Organization / team
                <select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
                  <option value="">Not assigned</option>
                  {(selectedAccount?.organizations ?? []).map((org) => (
                    <option key={org.id} value={org.id}>{org.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Resource name
                <input
                  autoFocus
                  placeholder="Project, repository, deployment…"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label>
                Provider reference <span className="muted">(optional)</span>
                <input
                  placeholder="project ref / repo slug / external id"
                  value={providerRef}
                  onChange={(e) => setProviderRef(e.target.value)}
                />
              </label>
              <EnvironmentSelect value={environment} onChange={setEnvironment} />
            </>
          )}

          {kind === "secret" && (
            <>
              <label>
                Belongs to
                <select value={secretTarget} onChange={(e) => setSecretTarget(e.target.value)}>
                  <option value="">Choose project or provider resource…</option>
                  <optgroup label="My projects">
                    {projects.map((p) => (
                      <option key={p.project.id} value={`project:${p.project.id}`}>
                        {p.project.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Provider resources">
                    {resources.map((r) => (
                      <option key={r.service_project.id} value={`resource:${r.service_project.id}`}>
                        {r.account_label} · {r.service_project.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <label>
                Variable / key name
                <input
                  autoFocus
                  placeholder="RESEND_API_KEY"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label>
                Secret value
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the value"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                />
              </label>
              <EnvironmentSelect value={environment} onChange={setEnvironment} />
              <div className="note">
                Stored encrypted immediately. The value is never persisted in frontend state after this dialog closes.
              </div>
            </>
          )}
        </div>
        <footer>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? "Adding…" : "Add"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function EnvironmentSelect({
  value,
  onChange,
}: {
  value: Environment;
  onChange: (value: Environment) => void;
}) {
  return (
    <label>
      Environment
      <select value={value} onChange={(e) => onChange(e.target.value as Environment)}>
        <option value="unknown">Not specified</option>
        <option value="production">Production</option>
        <option value="staging">Preview / staging</option>
        <option value="development">Development</option>
      </select>
    </label>
  );
}
