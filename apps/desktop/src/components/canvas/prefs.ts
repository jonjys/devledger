// Small things the canvas keeps outside React: how the map is fitted, the
// remembered layout lock, the motion preference and how an error reads.

// The margin is per side, in pixels: room at the top for the toolbar that sits
// over the map, and at the bottom for the names that hang under the balls,
// which are not part of a ball's box. The zoom cap keeps a map of one ball
// from filling the screen.
export const FIT = {
  padding: { top: "72px", bottom: "64px", x: "48px" } as { top: `${number}px`; bottom: `${number}px`; x: `${number}px` },
  maxZoom: 1.1,
};
/** How long balls take to glide to a new place when the layout changes. */
export const GLIDE_MS = 460;
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
