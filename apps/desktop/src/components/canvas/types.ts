// Shapes shared by the canvas and the pieces split out of it.

import type { ReactFlowInstance } from "@xyflow/react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { type Ball, type Intent, type Line, type Point } from "../../lib/canvas";
import { type AddKind, type MenuItem } from "../CanvasParts";

import { type Loaded } from "./data";
import type { Step } from "./history";
import type { useCanvasActions } from "./useCanvasActions";

/** A line drawn between two balls that means something. */
export type Act = Exclude<Intent, { kind: "none" } | { kind: "refuse" }>;

export type Dialog = { kind: AddKind; ball: Ball | null; at: Point | null; name?: string; title?: string };
/** A right-click on a ball, a line or the background, or a line dragged from `drop` into empty space. */
export type Menu = {
  x: number;
  y: number;
  at: Point;
  ball: string | null;
  line: string | null;
  /** A menu built in advance, e.g. for a line dragged into empty space. */
  title?: string;
  items?: MenuItem[];
};

/** What the canvas hands the pieces split out of it: its state, and how to change it. */
export interface CanvasCore {
  data: Loaded | null;
  setData: Dispatch<SetStateAction<Loaded | null>>;
  locked: boolean;
  setLocked: Dispatch<SetStateAction<boolean>>;
  selected: string | null;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setSelectedLine: Dispatch<SetStateAction<string | null>>;
  setRenaming: Dispatch<SetStateAction<string | null>>;
  setDialog: Dispatch<SetStateAction<Dialog | null>>;
  setMenu: Dispatch<SetStateAction<Menu | null>>;
  setFinder: Dispatch<SetStateAction<boolean>>;
  setMoved: Dispatch<SetStateAction<Map<string, Point>>>;
  model: { balls: Ball[]; lines: Line[] };
  byKey: Map<string, Ball>;
  place: Map<string, Point>;
  projectId: string | null;
  projectKey: string | null;
  flow: ReactFlowInstance;
  wrapRef: RefObject<HTMLDivElement | null>;
  renameRef: RefObject<(key: string, value: string | null) => Promise<void>>;
  onNotify: (message: string, bad?: boolean) => void;
  onOpenProject?: (projectId: string) => void;
  changed: () => Promise<void>;
  record: (step: Step) => void;
}

/** What the canvas can do, as `useCanvasActions` returns it. */
export type CanvasActions = ReturnType<typeof useCanvasActions>;
