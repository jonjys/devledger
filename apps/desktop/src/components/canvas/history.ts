// Undo and redo for the map: each step knows how to take itself back and do
// itself again. Deleting is never a step; it asks first instead.

import { useRef, useState } from "react";

import { message } from "./prefs";

/** One thing done on the map, and how to take it back and do it again. */
export interface Step {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Whether the map reloads afterwards. A move does not need to. */
  reload?: boolean;
}
export const MAX_STEPS = 50;

/** The undo and redo stacks, and the two ways to move along them. */
export function useHistory({
  locked,
  onNotify,
  changed,
}: {
  locked: boolean;
  onNotify: (message: string, bad?: boolean) => void;
  changed: () => Promise<void>;
}) {
  const history = useRef<{ past: Step[]; future: Step[] }>({ past: [], future: [] });
  const replaying = useRef(false);
  const [, setHistoryTick] = useState(0);

  function record(step: Step) {
    if (replaying.current) return;
    const h = history.current;
    h.past = [...h.past, step].slice(-MAX_STEPS);
    h.future = [];
    setHistoryTick((t) => t + 1);
  }

  async function travel(back: boolean) {
    if (locked) return;
    const h = history.current;
    const step = back ? h.past.pop() : h.future.pop();
    if (!step) return;
    replaying.current = true;
    try {
      await (back ? step.undo() : step.redo());
      (back ? h.future : h.past).push(step);
      onNotify(`${back ? "Undid" : "Redid"} ${step.label}`);
    } catch (e: unknown) {
      onNotify(`Could not ${back ? "undo" : "redo"} ${step.label}: ${message(e)}`, true);
    } finally {
      replaying.current = false;
      setHistoryTick((t) => t + 1);
    }
    if (step.reload !== false) await changed();
  }

  return { history, record, travel };
}
