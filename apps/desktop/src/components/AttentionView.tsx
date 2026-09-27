import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import type { AttentionItem, Identity } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  refreshKey: number;
  onChanged?: () => void;
}

/** Everything DevLedger could not work out on its own — the alerts inbox. */
export default function AttentionView({ onNotify, refreshKey, onChanged }: Props) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [attention, people] = await Promise.all([api.needsAttention(), api.listIdentities()]);
      setItems(attention);
      setIdentities(people);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const changed = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  // Entries with no email first: everything under them is filed nowhere.
  const sorted = [...items].sort(
    (a, b) => Number(b.kind === "identity_without_email") - Number(a.kind === "identity_without_email"),
  );

  return (
    <div className="dash">
      <div className="dash-head">
        <h1>Needs attention</h1>
        <div className="dash-date">
          {loading ? "Checking…" : plural(items.length, "open item")}
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <p style={{ margin: 0, fontWeight: 600 }}>All clear</p>
          <p style={{ marginBottom: 0 }}>Nothing needs your attention right now.</p>
        </div>
      ) : (
        <section className="card">
          {sorted.map((item, i) =>
            item.kind === "identity_without_email" ? (
              <Unidentified
                key={`${item.entity.id}-${item.kind}-${i}`}
                item={item}
                targets={identities.filter((p) => p.id !== item.entity.id && p.email)}
                onNotify={onNotify}
                onChanged={changed}
              />
            ) : (
              <div key={`${item.entity.id}-${item.kind}-${i}`} className="finding warning">
                <div className="t">{item.title}</div>
                <div className="d">{item.detail}</div>
              </div>
            ),
          )}
        </section>
      )}
    </div>
  );
}

/**
 * An entry with no email address. Its accounts belong to someone; moving them
 * to that person is the fix, and an entry left empty can then go.
 */
function Unidentified({
  item,
  targets,
  onNotify,
  onChanged,
}: {
  item: AttentionItem;
  targets: Identity[];
  onNotify: Props["onNotify"];
  onChanged: () => Promise<void>;
}) {
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .accountsForIdentity(item.entity.id)
      .then((accounts) => setCount(accounts.length))
      .catch(() => setCount(null));
  }, [item.entity.id]);

  useEffect(() => {
    if (!targets.some((t) => t.id === target)) setTarget(targets[0]?.id ?? "");
  }, [targets, target]);

  async function move() {
    const to = targets.find((t) => t.id === target);
    if (!to || busy) return;
    setBusy(true);
    try {
      const accounts = await api.accountsForIdentity(item.entity.id);
      for (const account of accounts) await api.moveAccount(account.id, to.id);
      onNotify(`Moved ${plural(accounts.length, "account")} to ${to.email ?? to.label}`);
      await onChanged();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !window.confirm("Delete this empty entry? It holds no accounts.")) return;
    setBusy(true);
    try {
      await api.deleteIdentity(item.entity.id);
      onNotify("Removed the empty entry");
      await onChanged();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="finding critical pulse" aria-label="No email">
      <div className="t">{item.title}</div>
      <div className="d">{item.detail}</div>
      <div className="attention-actions">
        {count === 0 ? (
          <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
            Delete empty entry
          </button>
        ) : targets.length === 0 ? (
          <span className="muted-p">Add a person with an email address first, then move these accounts to them.</span>
        ) : (
          <>
            <label htmlFor={`move-${item.entity.id}`}>Move to identity</label>
            <select
              id={`move-${item.entity.id}`}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.email ?? t.label}
                </option>
              ))}
            </select>
            <button type="button" className="primary" onClick={() => void move()} disabled={busy || !target}>
              {busy ? "Moving…" : count === null ? "Move accounts" : `Move ${plural(count, "account")}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
