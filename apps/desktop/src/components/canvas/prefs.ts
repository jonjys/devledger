// Small things the canvas keeps outside React: how the map is fitted, the
// remembered layout lock, the motion preference and how an error reads.

// The margin is per side, as a share of the view. Fitting a map of one ball
// would otherwise zoom it to fill the screen.
export const FIT = { padding: 0.15, maxZoom: 1.1 };
export const LOCK_KEY = "devledger.mapLocked";

/** Animated moves, unless the system asks for less motion (or cannot say). */
export function motion(ms: number): number {
  if (typeof window.matchMedia !== "function") return 0;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The layout lock as last left, or null on a fresh install. */
export function readLocked(): boolean | null {
  try {
    const v = window.localStorage.getItem(LOCK_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

export function writeLocked(locked: boolean) {
  try {
    window.localStorage.setItem(LOCK_KEY, locked ? "1" : "0");
  } catch {
    // The lock just will not be remembered.
  }
}
