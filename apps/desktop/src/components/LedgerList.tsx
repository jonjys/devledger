import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { isCustomProvider, plural, providerFromInput, providerLabel } from "../lib/format";
import type { IdentityEmail, LedgerIdentity } from "../lib/types";
import AccountCard from "./AccountCard";
import FieldsEditor from "./FieldsEditor";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
}

/**
 * The ledger: every person, every address they use, and everything that hangs
 * off those addresses, down to the projects it all ends up in.
 *
 * This is the one screen that answers "which of my email addresses is this
 * project actually running on?" -- the question the rest of the model exists to
 * make answerable. Everything here can be created and corrected by hand, with
 * no token and no connector; discovery only ever adds to it.
 */
export default function LedgerList({ onNotify, onChanged, refreshKey }: Props) {
  const [people, setPeople] = useState<LedgerIdentity[] | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setPeople(await api.ledgerOverview());
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const changed = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  return (
    <div className="dash ledger">
      <div className="dash-head">
        <h1>Ledger</h1>
        <span className="spacer" />
        <button type="button" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ Person"}
        </button>
      </div>
      <p className="note">
        Each person, the addresses they sign in with, the accounts under those addresses,
        and the projects those accounts end up in. Nothing here needs a token.
      </p>

      {adding && (
        <NewPersonForm
          onNotify={onNotify}
          onCreated={async () => {
            setAdding(false);
            await changed();
          }}
        />
      )}

      {people === null ? (
        <div className="empty">Loading…</div>
      ) : people.length === 0 ? (
        <div className="empty">
          No one yet. Add yourself with <strong>+ Person</strong>, then the accounts you hold.
        </div>
      ) : (
        people.map((person) => (
          <PersonCard
            key={person.identity.id}
            person={person}
            onNotify={onNotify}
            onChanged={changed}
          />
        ))
      )}
    </div>
  );
}

function NewPersonForm({
  onNotify,
  onCreated,
}: {
  onNotify: Props["onNotify"];
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy || (!name.trim() && !email.trim())) return;
    setBusy(true);
    try {
      const identity = await api.createIdentityManual(name.trim(), email.trim() || null);
      onNotify(`Added ${identity.label}`);
      await onCreated();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="inline-form ledger-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        aria-label="Name"
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="Email address"
        placeholder="Email address"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy || (!name.trim() && !email.trim())}>
        Add person
      </button>
    </form>
  );
}

function PersonCard({
  person,
  onNotify,
  onChanged,
}: {
  person: LedgerIdentity;
  onNotify: Props["onNotify"];
  onChanged: () => Promise<void>;
}) {
  const { identity, emails, accounts, projects, secret_count } = person;
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(identity.label);
  const [addingEmail, setAddingEmail] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);

  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      onNotify(done);
      await onChanged();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <section className="ledger-person" aria-label={`Person ${identity.label}`}>
      <div className="map-head">
        <span className="map-kind">Person</span>
        {renaming ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.updateIdentity(identity.id, label), "Renamed").then(() =>
                setRenaming(false),
              );
            }}
          >
            <input
              autoFocus
              aria-label="Person name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button type="submit" disabled={!label.trim()}>
              Save
            </button>
            <button type="button" className="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <span className="map-name">{identity.label}</span>
        )}
        <span className="map-meta">
          {plural(accounts.length, "account")} · {plural(projects.length, "project")} ·{" "}
          {plural(secret_count, "secret")}
        </span>
        <span className="spacer" />
        {!renaming && (
          <button type="button" className="ghost tiny" onClick={() => setRenaming(true)}>
            Rename
          </button>
        )}
        <button
          type="button"
          className="ghost tiny danger"
          onClick={() => {
            const what =
              accounts.length === 0
                ? identity.label
                : `${identity.label} and ${plural(accounts.length, "account")} with everything filed under them`;
            if (window.confirm(`Delete ${what}? This cannot be undone.`)) {
              void run(() => api.deleteIdentity(identity.id), `Deleted ${identity.label}`);
            }
          }}
        >
          Delete
        </button>
      </div>

      <div className="ledger-section">
        <div className="ledger-label">Addresses</div>
        {emails.length === 0 ? (
          <div className="muted">
            No address yet. Without one, pastes and connections cannot be matched to this person.
          </div>
        ) : (
          <ul className="ledger-emails" aria-label={`Addresses of ${identity.label}`}>
            {emails.map((email) => (
              <EmailRow
                key={email.id}
                email={email}
                onlyOne={emails.length === 1}
                onMakePrimary={() =>
                  void run(
                    () => api.setPrimaryEmail(identity.id, email.id),
                    `${email.address} is now the primary address`,
                  )
                }
                onRemove={() =>
                  void run(
                    () => api.removeIdentityEmail(identity.id, email.id),
                    `Removed ${email.address}`,
                  )
                }
              />
            ))}
          </ul>
        )}
        {addingEmail ? (
          <AddEmailForm
            onCancel={() => setAddingEmail(false)}
            onSubmit={(address) =>
              run(
                () => api.addIdentityEmail(identity.id, address, emails.length === 0),
                `Added ${address}`,
              ).then(() => setAddingEmail(false))
            }
          />
        ) : (
          <button type="button" className="ghost tiny" onClick={() => setAddingEmail(true)}>
            + Address
          </button>
        )}
      </div>

      <div className="ledger-section">
        <div className="ledger-label">Fields</div>
        <FieldsEditor entity={{ kind: "identity", id: identity.id }} onNotify={onNotify} />
      </div>

      <div className="ledger-section">
        <div className="ledger-label">Accounts</div>
        {accounts.length === 0 && <div className="muted">No accounts yet.</div>}
        {accounts.map((node) => (
          <AccountCard key={node.account.id} node={node} emails={emails} onNotify={onNotify} onChanged={onChanged} />
        ))}
        {addingAccount ? (
          <NewAccountForm
            identityId={identity.id}
            emails={emails}
            onNotify={onNotify}
            onCancel={() => setAddingAccount(false)}
            onCreated={async () => {
              setAddingAccount(false);
              await onChanged();
            }}
          />
        ) : (
          <button type="button" className="ghost tiny" onClick={() => setAddingAccount(true)}>
            + Account
          </button>
        )}
      </div>

      <div className="ledger-section">
        <div className="ledger-label">Projects</div>
        {projects.length === 0 ? (
          <div className="muted">
            None of this person's accounts are linked to a project yet. Link a resource to a
            project from the Identities map.
          </div>
        ) : (
          <div className="ledger-projects">
            {projects.map((p) => (
              <span key={p.id} className="tag">
                {p.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function EmailRow({
  email,
  onlyOne,
  onMakePrimary,
  onRemove,
}: {
  email: IdentityEmail;
  onlyOne: boolean;
  onMakePrimary: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="ledger-email">
      <span className="mono">{email.address}</span>
      {email.is_primary && <span className="tag strong">primary</span>}
      <span className="spacer" />
      {!email.is_primary && (
        <button type="button" className="ghost tiny" onClick={onMakePrimary}>
          Make primary
        </button>
      )}
      {(!email.is_primary || onlyOne) && (
        <button
          type="button"
          className="ghost tiny danger"
          aria-label={`Remove ${email.address}`}
          onClick={onRemove}
        >
          Remove
        </button>
      )}
    </li>
  );
}

function AddEmailForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (address: string) => Promise<void>;
}) {
  const [address, setAddress] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (address.trim()) void onSubmit(address.trim());
      }}
    >
      <input
        autoFocus
        type="email"
        aria-label="New address"
        placeholder="another@example.com"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <button type="submit" disabled={!address.trim()}>
        Add
      </button>
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Services DevLedger knows by name, offered as suggestions. Anything else is fine too. */
const SERVICE_SUGGESTIONS = [
  "Supabase",
  "Vercel",
  "GitHub",
  "Stripe",
  "OpenAI",
  "Anthropic",
  "AWS",
  "Postgres",
];

function NewAccountForm({
  identityId,
  emails,
  onNotify,
  onCancel,
  onCreated,
}: {
  identityId: string;
  emails: IdentityEmail[];
  onNotify: Props["onNotify"];
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const primary = emails.find((e) => e.is_primary)?.address ?? "";
  const [service, setService] = useState("");
  const [label, setLabel] = useState("");
  const [loginEmail, setLoginEmail] = useState(primary);
  const [username, setUsername] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const provider = providerFromInput(service);
  const ready = service.trim() !== "" && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    try {
      const account = await api.createAccountManual(
        identityId,
        provider,
        label.trim() || providerLabel(provider),
        {
          login_email: loginEmail.trim() || null,
          username: username.trim() || null,
          url: url.trim() || null,
          notes: null,
        },
      );
      onNotify(`Added ${providerLabel(account.provider)} account ${account.label}`);
      await onCreated();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="form-stack ledger-form"
      aria-label="New account"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        Service
        <input
          autoFocus
          list="ledger-services"
          placeholder="Any service — Supabase, Loopia, your bank…"
          value={service}
          onChange={(e) => setService(e.target.value)}
        />
        <datalist id="ledger-services">
          {SERVICE_SUGGESTIONS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      {service.trim() && (
        <div className="muted">
          {isCustomProvider(provider)
            ? `Recorded as a custom service, "${providerLabel(provider)}".`
            : `Recognised as ${providerLabel(provider)}.`}
        </div>
      )}
      <label>
        Label
        <input
          placeholder={service.trim() ? providerLabel(provider) : "e.g. Work, Client X"}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label>
        Signs in with
        <input
          type="email"
          list="ledger-addresses"
          placeholder="login address"
          value={loginEmail}
          onChange={(e) => setLoginEmail(e.target.value)}
        />
        <datalist id="ledger-addresses">
          {emails.map((e) => (
            <option key={e.id} value={e.address} />
          ))}
        </datalist>
      </label>
      <label>
        Username
        <input
          placeholder="optional"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label>
        Sign-in URL
        <input placeholder="optional" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <div className="row-acts">
        <button type="submit" className="primary" disabled={!ready}>
          Add account
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="note">
        Add the password or API keys once the account exists. They are encrypted before they
        are stored and never shown again unless you press Reveal.
      </p>
    </form>
  );
}
