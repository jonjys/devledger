import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The two ways DevLedger can present the same ledger.
 *
 * - **indie**: clean and human-readable. Raw environment-variable names,
 *   provider references, JWT tags and masked hashes are hidden in favour of
 *   friendly labels and provider names.
 * - **dev**: everything, including the technical detail an engineer wants when
 *   wiring a service up.
 *
 * It is a display concern only: nothing about what is stored changes with the
 * mode, and no secret ever depends on it.
 */
export type Mode = "indie" | "dev";

const STORAGE_KEY = "devledger.mode";

interface ModeContextValue {
  mode: Mode;
  dev: boolean;
  setMode: (mode: Mode) => void;
  toggle: () => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

function readInitialMode(): Mode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "dev" ? "dev" : "indie";
  } catch {
    return "indie";
  }
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readInitialMode);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // A vault that cannot reach localStorage still works; it just does not
      // remember the toggle between launches.
    }
  }, [mode]);

  const setMode = useCallback((next: Mode) => setModeState(next), []);
  const toggle = useCallback(
    () => setModeState((m) => (m === "dev" ? "indie" : "dev")),
    [],
  );

  const value = useMemo(
    () => ({ mode, dev: mode === "dev", setMode, toggle }),
    [mode, setMode, toggle],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

/** Read the current display mode. Falls back to indie outside a provider. */
export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (ctx) return ctx;
  return { mode: "indie", dev: false, setMode: () => undefined, toggle: () => undefined };
}
