import { useCallback, useEffect, useState } from "react";

import DesktopShell from "./components/DesktopShell";
import UnlockScreen from "./components/UnlockScreen";
import * as api from "./lib/api";
import type { VaultStatus } from "./lib/types";

/**
 * Routes between the gate and the shell based on vault state.
 *
 * There is no client-side session: "unlocked" is whatever Rust reports, so a
 * backend-side lock (explicit, or a future idle timeout) immediately returns
 * the user to the gate.
 */
export default function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .vaultStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const lock = useCallback(async () => {
    try {
      setStatus(await api.vaultLock());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (error) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="error" role="alert">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!status) {
    return <div className="gate" />;
  }

  if (!status.unlocked) {
    return <UnlockScreen status={status} onOpened={setStatus} />;
  }

  return <DesktopShell onLock={lock} />;
}
