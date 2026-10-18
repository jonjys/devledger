// Balls glide to a new place instead of jumping there.
//
// When the layout changes -- a service added on a project's page, the map
// tidied up, an undo -- every ball eases from where it is drawn now to where
// it belongs. The lines follow, because they are drawn from the balls. A ball
// that was not there before comes out of `spawn` (on a project's page, the
// project itself), or simply appears where it belongs.

import { useCallback, useEffect, useRef, useState } from "react";

import type { Point } from "../../lib/canvas";

import { GLIDE_MS, motion } from "./prefs";

const same = (a: Point | undefined, b: Point) => a !== undefined && a.x === b.x && a.y === b.y;
const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * Where to draw each ball, gliding towards `target`. `settle` says a ball is
 * already somewhere -- where it was just dragged to -- so it does not glide
 * back from where it was before the drag.
 */
export function useGlide(target: Map<string, Point>, spawn: Point | null) {
  const [drawn, setDrawn] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    const from = current.current;
    const ms = motion(GLIDE_MS);
    const moves = [...target].some(([k, p]) => !same(from.get(k), p));
    // The first layout, a change with nothing to move, or less motion asked for: no glide.
    if (from.size === 0 || ms === 0 || !moves) {
      current.current = target;
      setDrawn(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = ease(t);
      const next = new Map<string, Point>();
      for (const [k, p] of target) {
        const f = from.get(k) ?? spawn ?? p;
        next.set(k, { x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e });
      }
      current.current = next;
      setDrawn(next);
      if (t < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [target, spawn]);

  const settle = useCallback((at: Map<string, Point>) => {
    const next = new Map(current.current);
    for (const [k, p] of at) next.set(k, p);
    current.current = next;
  }, []);

  return [drawn, settle] as const;
}
