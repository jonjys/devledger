import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import DesktopShell from "./components/DesktopShell";
import UnlockScreen from "./components/UnlockScreen";
import * as api from "./lib/api";
import type { VaultStatus } from "./lib/types";

/**
 * Routes between the gate and the shell based on vault state.
 *
 * There is no client-side session: "unlocked" is whatever Rust reports. The
 * vault can also lock without being asked -- Rust locks it after a spell of
 * inactivity -- so the app listens for that, and for any call that finds the
 * vault locked, and returns to the gate at once. Unmounting the shell is what
 * clears a value someone had revealed and walked away from.
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

  useEffect(() => {
    const toGate = () => {
      api
        .vaultStatus()
        .then(setStatus)
        .catch(() => setStatus((s) => (s ? { ...s, unlocked: false } : s)));
    };
    window.addEventListener(api.VAULT_LOCKED_EVENT, toGate);

    // Rust announces an idle lock as it happens, so nothing revealed stays on
    // screen until the next click.
    let unlisten: (() => void) | undefined;
    listen("vault-locked", toGate)
      .then((stop) => {
        unlisten = stop;
      })
      .catch(() => {
        // No Tauri runtime (tests, a plain browser): the call-level signal above
        // still returns the user to the gate on their next action.
      });

    return () => {
      window.removeEventListener(api.VAULT_LOCKED_EVENT, toGate);
      unlisten?.();
    };
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
