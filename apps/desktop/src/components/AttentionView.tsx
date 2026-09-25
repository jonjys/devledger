import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import type { AttentionItem } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  refreshKey: number;
}

/** Everything DevLedger could not work out on its own — the alerts inbox. */
export default function AttentionView({ onNotify, refreshKey }: Props) {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.needsAttention());
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

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
          {items.map((item, i) => (
            <div key={`${item.entity.id}-${item.kind}-${i}`} className="finding warning">
              <div className="t">{item.title}</div>
              <div className="d">{item.detail}</div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
