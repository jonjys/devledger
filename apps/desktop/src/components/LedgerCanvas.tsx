import "@xyflow/react/dist/style.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ballKey,
  besideSpot,
  buildCanvas,
  focusLayout,
  foldedView,
  insideCounts,
  neighbourhood,
  projectView,
  serviceHulls,
  sideRelations,
  slotSpot,
  tidyLayout,
  type Ball,
  type Line,
  type Point,
} from "../lib/canvas";
import { providerForName } from "../lib/providers";
import type { Provider } from "../lib/types";

import {
  AddDialog,
  BallView,
  ContextMenu,
  Finder,
  HullView,
  LineView,
  SLOT_SIZE,
  ServicePicker,
  SlotView,
  ballSize,
  type BallNode,
  type FindEntry,
  type HullNode,
  type LineData,
  type SlotNode,
} from "./CanvasParts";
import { Details } from "./canvas/CanvasDetails";
import { Guide, HowItWorks } from "./canvas/CanvasHelp";
import { Shelf } from "./canvas/CanvasShelf";
import { canvasMenus } from "./canvas/canvasMenus";
import { load, type Loaded } from "./canvas/data";
import { useGlide } from "./canvas/glide";
import { useHistory } from "./canvas/history";
import { FIT, GLIDE_MS, message, motion, readLocked } from "./canvas/prefs";
import type { CanvasCore, Dialog, Menu, Picking } from "./canvas/types";
import { useCanvasActions } from "./canvas/useCanvasActions";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
  /** Show only this project and what it is connected to. */
  projectId?: string | null;
  /** Open a project's own page. */
  onOpenProject?: (projectId: string) => void;
}

const nodeTypes = { ball: BallView, slot: SlotView, hull: HullView };
type CanvasNode = BallNode | SlotNode | HullNode;

/** The empty slot on the page of a project that runs on nothing yet. */
const SLOT = "slot:first-service";
const edgeTypes = { line: LineView };

/**
 * The Ledger as a map you draw.
 *
 * Emails, the services you use and your projects are balls. The map lays
 * itself out: each service beside the email that owns it, projects level with
 * what they run on, lines turning at right angles. Accounts start folded, with
 * a count of what is inside; open one to see it. Lines are what the vault
 * records. Drag from a ball's port to connect, drag services in from the list,
 * right-click anything, double-click to rename. Lock the map and nothing can
 * be moved, connected or deleted until it is unlocked again.
 */
export default function LedgerCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ onNotify, onChanged, refreshKey, projectId = null, onOpenProject }: Props) {
  const flow = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Loaded | null>(null);
  // Locked unless someone chose otherwise: a map that has been drawn should
  // not change by accident. The exceptions are an empty map, which is being
  // set up -- see the effect below -- and a project's page, which lays itself
  // out and is where a project is built: it always opens ready to edit.
  const [stored] = useState(readLocked);
  const [locked, setLocked] = useState(projectId ? false : (stored ?? true));
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [finder, setFinder] = useState(false);
  const [help, setHelp] = useState(false);
  /** Account keys the user has opened. Everything else starts folded. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** A ball the pointer has rested on. A hint only; it does not dim the map. */
  const [hover, setHover] = useState<string | null>(null);
  const hoverTimer = useRef(0);
  // Where balls have been dragged this session, on top of what the vault says.
  const [moved, setMoved] = useState<Map<string, Point>>(new Map());
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  // A project's page stands upright on a narrow screen, so a phone shows it
  // larger. A first guess from the window, so a phone does not see it turn.
  const [upright, setUpright] = useState(() => window.innerWidth < 640);

  const reload = useCallback(async () => {
    try {
      setData(await load());
      setMoved(new Map());
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }, [onNotify]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const changed = useCallback(async () => {
    await reload();
    onChanged();
  }, [reload, onChanged]);

  // --- the model ------------------------------------------------------------------

  const model = useMemo(() => (data ? buildCanvas(data) : { balls: [], lines: [] }), [data]);

  // First run: nothing to protect yet, so start in edit mode. The choice is
  // not remembered, so the next start is locked like any other.
  const setupChecked = useRef(false);
  useEffect(() => {
    if (!data || setupChecked.current) return;
    setupChecked.current = true;
    if (stored === null && model.balls.length === 0) setLocked(false);
  }, [data, model, stored]);
  const projectKey = projectId ? ballKey("project", projectId) : null;
  const shown = useMemo(
    () => (projectKey ? projectView(model.balls, model.lines, projectKey) : null),
    [model, projectKey],
  );
  const balls = useMemo(() => (shown ? model.balls.filter((b) => shown.has(b.key)) : model.balls), [model, shown]);
  const lines = useMemo(
    () => (shown ? model.lines.filter((l) => shown.has(l.source) && shown.has(l.target)) : model.lines),
    [model, shown],
  );
  const byKey = useMemo(() => new Map(model.balls.map((b) => [b.key, b])), [model]);
  const counts = useMemo(() => insideCounts(model.balls), [model]);
  // The main map folds accounts until they are opened. A project's page does
  // not: it is already the few balls that project needs.
  const view = useMemo(
    () => (projectKey ? { balls, lines } : foldedView(balls, lines, expanded)),
    [projectKey, balls, lines, expanded],
  );

  const place = useMemo(() => {
    // Auto-layout is the layout. A drag this session sits on top of it until
    // Tidy up, or the next reload, puts the ball back. There is no mode toggle.
    const base =
      projectKey && data
        ? focusLayout(view.balls, view.lines, projectKey, { upright })
        : tidyLayout(view.balls, view.lines);
    for (const [k, p] of moved) base.set(k, p);
    return base;
  }, [data, view, projectKey, moved, upright]);

  // Balls glide to a new place; on a project's page a new one comes out of the project.
  const spawn = useMemo(() => (projectKey ? (place.get(projectKey) ?? null) : null), [place, projectKey]);
  const [drawn, settle] = useGlide(place, spawn);
  const needsService =
    projectKey !== null &&
    view.balls.some((b) => b.key === projectKey) &&
    !view.lines.some((l) => l.kind === "uses" && l.source === projectKey);

  const lit = useMemo(() => (selected ? neighbourhood(model.lines, selected) : null), [model, selected]);

  // Nodes are memoised; they call the latest `rename` through a ref so a
  // rename never works on the data as it was when the ball was drawn.
  const renameRef = useRef<(key: string, value: string | null) => Promise<void>>(async () => undefined);
  const onRename = useCallback((key: string, value: string | null) => void renameRef.current(key, value), []);
  const toggleFold = useCallback((key: string, open: boolean) => {
    setExpanded((prev) => {
      if (prev.has(key) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Something added inside an account opens that account, so the new ball is
  // not created and then immediately hidden.
  const knownInside = useRef<Set<string> | null>(null);
  useEffect(() => {
    const inside = new Set(model.balls.filter((b) => b.kind === "org" || b.kind === "resource").map((b) => b.key));
    const before = knownInside.current;
    knownInside.current = inside;
    if (!before) return;
    const added = [...inside].filter((k) => !before.has(k));
    if (added.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of added) {
        let parent = model.balls.find((b) => b.key === k)?.parent ?? null;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          const ball = model.balls.find((b) => b.key === parent);
          if (!ball) break;
          if (ball.kind === "account") next.add(ball.key);
          parent = ball.parent;
        }
      }
      return next;
    });
  }, [model]);

  const hulls = useMemo(() => (projectKey ? [] : serviceHulls(view.balls)), [projectKey, view]);

  useEffect(() => {
    setNodes((prev) => {
      // A box- or shift-selection belongs to xyflow; keep it across redraws.
      const picked = new Set(locked ? [] : prev.filter((n) => n.selected).map((n) => n.id));
      const shown: CanvasNode[] = view.balls.map((b) => {
        const size = ballSize(b);
        const inside = counts.get(b.key) ?? 0;
        return {
          id: b.key,
          type: "ball" as const,
          position: drawn.get(b.key) ?? { x: 0, y: 0 },
          // A size to draw with until the ball has been measured: xyflow hides
          // a node it has no size for.
          initialWidth: size,
          initialHeight: size,
          draggable: !locked && renaming !== b.key,
          selectable: !locked,
          selected: picked.has(b.key),
          data: {
            ball: b,
            selected: selected === b.key,
            dim: lit !== null && !lit.has(b.key),
            preview: hover === b.key,
            renaming: renaming === b.key,
            locked,
            fold: !projectKey && b.kind === "account" && inside > 0 ? { open: expanded.has(b.key), inside } : null,
            onToggleFold: toggleFold,
            onRename,
          },
        };
      });
      if (!projectKey) {
        for (const hull of hulls) {
          const pts = hull.members
            .map((k) => drawn.get(k))
            .filter((p): p is Point => p !== undefined);
          if (pts.length < 2) continue;
          const minX = Math.min(...pts.map((p) => p.x)) - 86;
          const maxX = Math.max(...pts.map((p) => p.x)) + 86;
          const minY = Math.min(...pts.map((p) => p.y)) - 70;
          const maxY = Math.max(...pts.map((p) => p.y)) + 108;
          const width = maxX - minX;
          const height = maxY - minY;
          shown.push({
            id: hull.key,
            type: "hull",
            position: { x: minX + width / 2, y: minY + height / 2 },
            width,
            height,
            style: { width, height },
            zIndex: -1,
            draggable: false,
            selectable: false,
            connectable: false,
            data: { label: hull.label },
          });
        }
      }
      if (needsService && projectKey) {
        shown.push({
          id: SLOT,
          type: "slot" as const,
          position: slotSpot(drawn.get(projectKey) ?? { x: 0, y: 0 }, upright),
          initialWidth: SLOT_SIZE,
          initialHeight: SLOT_SIZE,
          draggable: false,
          selectable: false,
          data: { label: "Add a service", sub: "Pick one from the list" },
        });
      }
      return shown;
    });
  }, [view, drawn, selected, lit, hover, renaming, locked, onRename, toggleFold, needsService, projectKey, upright, hulls, counts, expanded]);

  // Lines that just appeared because the user drew them get the spinning-silk
  // entrance. A reload or a switch of view brings many lines at once; those
  // simply appear.
  const seenLines = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const keys = new Set(view.lines.map((l) => l.key));
    const before = seenLines.current;
    seenLines.current = keys;
    if (!before) return;
    const added = [...keys].filter((k) => !before.has(k));
    if (!added.length || added.length > 3) return;
    setFresh(new Set(added));
    const t = window.setTimeout(() => setFresh(new Set()), 1400);
    return () => window.clearTimeout(t);
  }, [view.lines]);
  const moving = useMemo(() => motion(1) > 0, []);

  const edges: Edge<LineData>[] = useMemo(
    () => [
      ...view.lines.map((l) => ({
        id: l.key,
        source: l.source,
        target: l.target,
        sourceHandle: "c",
        targetHandle: "in",
        type: "line",
        selectable: false,
        data: {
          kind: l.kind,
          lit: lit !== null && lit.has(l.source) && lit.has(l.target),
          dim: lit !== null && !(lit.has(l.source) && lit.has(l.target)),
          selected: selectedLine === l.key,
          fresh: fresh.has(l.key),
          moving,
        },
      })),
      ...(needsService && projectKey
        ? [
            {
              id: SLOT,
              source: projectKey,
              target: SLOT,
              sourceHandle: "c",
              targetHandle: "in",
              type: "line",
              selectable: false,
              data: { kind: "uses" as const, slot: true, lit: false, dim: false, selected: false },
            },
          ]
        : []),
    ],
    [view.lines, lit, selectedLine, fresh, moving, needsService, projectKey],
  );

  /** The email ball under a point on the page, for a service dropped onto it. */
  const emailAt = (p: Point): Ball | null =>
    view.balls.find((b) => {
      const q = drawn.get(b.key);
      return b.kind === "email" && !b.noEmail && q !== undefined && Math.hypot(q.x - p.x, q.y - p.y) < ballSize(b) / 2 + 24;
    }) ?? null;

  /** The list's search box, for the empty slot to point at. The list replaces a ball's details. */
  const focusSearch = useCallback(() => {
    setSelected(null);
    window.requestAnimationFrame(() => wrapRef.current?.querySelector<HTMLInputElement>(".cv-shelf-search")?.focus());
  }, []);

  // Bring the whole map into view when it first has something on it. A
  // project's page lays itself out, so it refits as services are added; the
  // big map does not, because the user just put the new ball where they wanted.
  // Only once the balls have been measured: fitting earlier works from sizes
  // the canvas does not have yet and zooms far out.
  const shape = projectKey ? `${projectKey}|${view.balls.length}|${upright}` : `map|${view.balls.length > 0}|${expanded.size}`;
  const measured = useNodesInitialized();
  const fitted = useRef<string | null>(null);
  const fitTimer = useRef(0);
  useEffect(() => {
    if (view.balls.length === 0 || !measured || fitted.current === shape) return;
    // After a change, once the balls have glided to where they are going;
    // the first time, a frame later, once the canvas has taken in its own size.
    // Not cancelled when `measured` flips as new balls are measured: the fit
    // for this shape is only ever asked for once.
    const wait = fitted.current === null ? 16 : motion(GLIDE_MS) + 30;
    fitted.current = shape;
    window.clearTimeout(fitTimer.current);
    fitTimer.current = window.setTimeout(() => void flow.fitView({ ...FIT, duration: motion(300) }), wait);
  }, [shape, measured, view.balls.length, flow]);
  useEffect(() => () => window.clearTimeout(fitTimer.current), []);

  // A project's page is laid out for it, so it is refitted when its box changes
  // size -- which it does while the page around it is still settling.
  useEffect(() => {
    const el = wrapRef.current?.querySelector(".cv-flow");
    if (!projectKey || !el || typeof ResizeObserver === "undefined") return;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      const size = entry ? `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}` : "";
      if (size === last) return;
      last = size;
      if (entry) setUpright(entry.contentRect.width < 600);
      window.requestAnimationFrame(() => void flow.fitView(FIT));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [projectKey, flow, data]);

  // --- what the canvas does, and its menus ---------------------------------------

  const { history, record, travel } = useHistory({ locked, onNotify, changed });
  const core: CanvasCore = {
    data,
    setData,
    locked,
    setLocked,
    selected,
    setSelected,
    setSelectedLine,
    setRenaming,
    setDialog,
    setPicking,
    setMenu,
    setFinder,
    setMoved,
    model,
    byKey,
    place,
    projectId,
    projectKey,
    flow,
    wrapRef,
    renameRef,
    onNotify,
    onOpenProject,
    changed,
    record,
  };
  const actions = useCanvasActions(core);
  const {
    secretsOf,
    namedFields,
    emails,
    projectBalls,
    accountBalls,
    resourceBalls,
    ownerOf,
    spotInView,
    connect,
    removeLine,
    addService,
    add,
    remove,
    copySecret,
    copyText,
    toggleLock,
    tidyUp,
    focusOn,
    setPositions,
    askService,
    pickerDefault,
    addPicked,
  } = actions;
  const show = useCallback(
    (key: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        let parent = byKey.get(key)?.parent ?? null;
        const seen = new Set<string>();
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          const ball = byKey.get(parent);
          if (!ball) break;
          if (ball.kind === "account") next.add(ball.key);
          parent = ball.parent;
        }
        return next;
      });
      focusOn(key);
    },
    [byKey, focusOn],
  );
  const { paneMenu, resourceDialog, ballMenu, dropOn, lineMenu } = canvasMenus({ ...core, ...actions });

  // --- keyboard ----------------------------------------------------------------------

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setFinder(true);
      return;
    }
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing || dialog || picking || finder) return;
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      void travel(e.key.toLowerCase() === "z" && !e.shiftKey);
      return;
    }
    if (e.key === "Escape") {
      setSelected(null);
      setSelectedLine(null);
      setNodes((n) => n.map((x) => (x.selected ? { ...x, selected: false } : x)));
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !locked) {
      const line = selectedLine ? model.lines.find((l) => l.key === selectedLine) : null;
      if (line) void removeLine(line);
      else if (selected) {
        const ball = byKey.get(selected);
        if (ball) void remove(ball);
      }
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- render -------------------------------------------------------------------------

  if (!data) return <div className="empty">Loading…</div>;

  const selectedBall = selected ? byKey.get(selected) ?? null : null;
  const relations = selectedBall ? sideRelations(selectedBall.key, model.balls, model.lines) : null;
  const undoStep = history.current.past.at(-1);
  const redoStep = history.current.future.at(-1);
  const builtMenu = menu
    ? menu.items
      ? { title: menu.title ?? "", items: menu.items }
      : menu.line
      ? lineMenu(model.lines.find((l) => l.key === menu.line) as Line)
      : menu.ball && byKey.get(menu.ball)
        ? ballMenu(byKey.get(menu.ball) as Ball)
        : paneMenu(menu.at)
    : null;
  const focusProject = projectKey ? byKey.get(projectKey) ?? null : null;
  const findEntries: FindEntry[] = model.balls.map((b) => ({ key: b.key, kind: b.kind, label: b.label, sub: b.sub }));
  const empty = balls.length === 0;

  return (
    <div
      ref={wrapRef}
      className={`ledger-canvas${locked ? " locked" : ""}${projectKey ? " focus" : ""}${
        nodes.filter((n) => n.selected).length > 1 ? " multi" : ""
      }`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="cv-toolbar">
        {focusProject && (
          <span className="cv-focus">
            <strong>{focusProject.label}</strong> and what it runs on
          </span>
        )}
        <button
          type="button"
          className={`cv-lock${locked ? "" : " editing"}`}
          aria-pressed={!locked}
          onClick={toggleLock}
          title={
            locked
              ? "The layout is locked: you can look, search and copy. Click to move, connect, rename or delete."
              : "Lock the layout again so nothing changes by accident."
          }
        >
          {locked ? "✎ Edit map" : "✓ Done editing"}
        </button>
        {!locked && (
          <>
            <button
              type="button"
              className="st-find"
              aria-label={undoStep ? `Undo ${undoStep.label}` : "Nothing to undo"}
              title={undoStep ? `Undo ${undoStep.label} (⌘Z)` : "Nothing to undo"}
              disabled={!undoStep}
              onClick={() => void travel(true)}
            >
              ↶
            </button>
            <button
              type="button"
              className="st-find"
              aria-label={redoStep ? `Redo ${redoStep.label}` : "Nothing to redo"}
              title={redoStep ? `Redo ${redoStep.label} (⇧⌘Z)` : "Nothing to redo"}
              disabled={!redoStep}
              onClick={() => void travel(false)}
            >
              ↷
            </button>
            {!projectKey && balls.length > 1 && (
              <button
                type="button"
                className="st-find"
                onClick={() => void tidyUp()}
                title="Line everything up: each service beside its email, projects level with what they run on. Undo puts it back."
              >
                Tidy up
              </button>
            )}
          </>
        )}
        <button type="button" className="st-find" onClick={() => setFinder(true)}>
          Find <kbd>⌘K</kbd>
        </button>
        <button type="button" className="st-find" aria-pressed={help} onClick={() => setHelp((h) => !h)}>
          How it works
        </button>
      </div>

      <div className="cv-flow">
        <ReactFlow<CanvasNode, Edge<LineData>>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes: NodeChange<CanvasNode>[]) => setNodes((n) => applyNodeChanges(changes, n))}
          onNodeDragStop={(_, node, dragged) => {
            // Several selected balls move together, and are put back together.
            const group = dragged.length > 0 ? dragged : [node];
            const before = new Map(group.map((n) => [n.id, place.get(n.id) ?? n.position]));
            const after = new Map(group.map((n) => [n.id, n.position]));
            // They are already where they were dropped; nothing should glide back.
            settle(after);
            void setPositions(after);
            if (projectKey) return;
            record({
              label: group.length > 1 ? `moving ${group.length} balls` : `moving ${byKey.get(node.id)?.label ?? "a ball"}`,
              undo: () => setPositions(before),
              redo: () => setPositions(after),
              reload: false,
            });
          }}
          onConnect={(c: Connection) => {
            const a = byKey.get(c.source);
            const b = byKey.get(c.target);
            if (a && b) void connect(a, b);
          }}
          onConnectEnd={(event, state: FinalConnectionState) => {
            // Let go over empty space: offer what can be added there.
            if (locked || state.isValid || state.toNode || !state.fromNode) return;
            const from = byKey.get(state.fromNode.id);
            const point = "changedTouches" in event ? event.changedTouches[0] : event;
            if (!from || !point) return;
            const client = { x: point.clientX, y: point.clientY };
            dropOn(from, flow.screenToFlowPosition(client), client);
          }}
          isValidConnection={(c) => c.source !== c.target}
          connectionRadius={70}
          onNodeClick={(event, node) => {
            if (node.type === "hull") return;
            if (event.target instanceof Element && event.target.closest(".cv-fold")) return;
            if (node.type === "slot") {
              focusSearch();
              return;
            }
            setSelectedLine(null);
            const ball = byKey.get(node.id);
            if (ball?.kind === "account" && !projectKey && (counts.get(ball.key) ?? 0) > 0 && !expanded.has(ball.key)) {
              setExpanded((prev) => new Set(prev).add(ball.key));
            }
            setSelected((s) => (s === node.id ? null : node.id));
          }}
          onNodeMouseEnter={(_, node) => {
            if (node.type !== "ball") return;
            window.clearTimeout(hoverTimer.current);
            hoverTimer.current = window.setTimeout(() => setHover(node.id), 320);
          }}
          onNodeMouseLeave={() => {
            window.clearTimeout(hoverTimer.current);
            setHover(null);
          }}
          onNodeDoubleClick={(_, node) => !locked && node.type === "ball" && setRenaming(node.id)}
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
            if (node.type !== "ball") return;
            setSelected(node.id);
            setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ball: node.id, line: null });
          }}
          onEdgeClick={(_, edge) => {
            setSelected(null);
            setSelectedLine((s) => (s === edge.id ? null : edge.id));
          }}
          onEdgeContextMenu={(e, edge) => {
            e.preventDefault();
            setSelectedLine(edge.id);
            setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ball: null, line: edge.id });
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ball: null, line: null });
          }}
          onPaneClick={() => {
            setSelected(null);
            setSelectedLine(null);
          }}
          nodeOrigin={[0.5, 0.5]}
          nodesConnectable={!locked}
          nodesDraggable={!locked}
          // Shift-drag draws a box; Ctrl/Cmd-click adds one ball at a time.
          elementsSelectable={!locked}
          selectionKeyCode="Shift"
          deleteKeyCode={null}
          // Double-click renames; the zoom handler would swallow it first.
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2.5}
          fitView
          fitViewOptions={FIT}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} color="#1A1A1A" bgColor="#0A0A0A" gap={22} size={1.6} />
          <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
        </ReactFlow>

        {empty && !projectKey && <Guide onEmail={() => setDialog({ kind: "email", ball: null, at: { x: 0, y: 0 } })} />}
        {empty && projectKey && <div className="cv-hint">This project is not on the map.</div>}
        {!empty && !projectKey && projectBalls.length === 0 && emails.length > 0 && !help && (
          <div className="cv-hint">
            Next: add a project from the list on the right, then draw a line from it to each service it runs on.
          </div>
        )}
        {help && <HowItWorks onClose={() => setHelp(false)} />}
      </div>

      {selectedBall ? (
        <Details
          ball={selectedBall}
          locked={locked}
          owner={selectedBall.kind === "account" ? ownerOf(selectedBall.id) : null}
          holder={
            selectedBall.kind === "org" || selectedBall.kind === "resource"
              ? (byKey.get(selectedBall.parent ?? "") ?? null)
              : null
          }
          inside={resourceBalls
            .filter((r) => r.parent === selectedBall.key)
            .sort((a, b) => a.label.localeCompare(b.label))}
          resourceOf={(id) => data.resourceById.get(id)}
          account={selectedBall.kind === "account" ? (data.accounts.get(selectedBall.id) ?? null) : null}
          secrets={secretsOf(selectedBall)}
          fields={namedFields(selectedBall)}
          owns={relations?.owns ?? []}
          usedBy={relations?.usedBy ?? []}
          dependsOn={relations?.projects ?? []}
          onClose={() => setSelected(null)}
          onPick={show}
          onCopySecret={(s) => void copySecret(s)}
          onCopyText={(label, text) => void copyText(label, text)}
          onAdd={(kind) => {
            const beside = besideSpot(place.get(selectedBall.key) ?? { x: 0, y: 0 }, place.values());
            if (kind === "resource") setDialog(resourceDialog(selectedBall, beside));
            else setDialog({ kind, ball: selectedBall, at: kind === "org" ? beside : null });
          }}
          onOpenProject={
            onOpenProject && !projectKey && selectedBall.kind === "project"
              ? () => onOpenProject(selectedBall.id)
              : undefined
          }
        />
      ) : (
        <Shelf
          // A project's page adds from the list even while the map is locked:
          // the lock is there so balls do not move by accident.
          locked={locked && !focusProject}
          focus={focusProject}
          existing={
            focusProject
              ? [...resourceBalls, ...accountBalls].filter(
                  (a) => !lines.some((l) => l.source === focusProject.key && l.target === a.key),
                )
              : []
          }
          whereIs={(b) => (b.kind === "account" ? ownerOf(b.id)?.label : byKey.get(b.parent ?? "")?.label) ?? null}
          have={new Set(accountBalls.map((a) => a.provider ?? ""))}
          loose={
            focusProject
              ? []
              : model.balls.filter((b) => !model.lines.some((l) => l.source === b.key || l.target === b.key))
          }
          onFind={show}
          canvas={wrapRef}
          onPlace={(item, client) => {
            const at = client ? flow.screenToFlowPosition(client) : null;
            // A new service: dropped next to an email on the map, or onto one on a
            // project's page, it is that email's; otherwise the picker asks whose.
            const service = (provider: Provider, name: string) => {
              if (at && !focusProject) void addService(provider, name, at);
              else {
                const onto = at ? emailAt(at) : null;
                if (onto) void addService(provider, name, at, onto);
                else askService(provider, name, at);
              }
            };
            if (item.kind === "email") setDialog({ kind: "email", ball: null, at: at ?? spotInView() });
            else if (item.kind === "project") setDialog({ kind: "project", ball: null, at: at ?? spotInView() });
            else if (item.kind === "other") service(providerForName(item.name), item.name);
            else if (item.kind === "existing" && focusProject) {
              const a = byKey.get(item.key);
              if (a) void connect(focusProject, a);
            } else if (item.kind === "service") service(item.provider, item.name);
          }}
          onUnlock={toggleLock}
        />
      )}

      {menu && builtMenu && (
        <ContextMenu x={menu.x} y={menu.y} title={builtMenu.title} items={builtMenu.items} onClose={() => setMenu(null)} />
      )}

      {finder && (
        <Finder
          entries={findEntries}
          onPick={(entry) => {
            setFinder(false);
            show(entry.key);
          }}
          onClose={() => setFinder(false)}
        />
      )}

      {picking && (
        <ServicePicker
          title={
            picking.project
              ? `Add ${picking.name} to ${byKey.get(`project:${picking.project}`)?.label ?? "the project"}`
              : `Add ${picking.name}`
          }
          service={picking.name}
          accounts={accountBalls
            .filter((a) => a.provider === picking.provider)
            .map((a) => ({ key: a.key, label: a.label, owner: ownerOf(a.id)?.label ?? null }))}
          emails={emails.map((e) => ({ key: e.key, label: e.label }))}
          initial={pickerDefault(picking)}
          onCancel={() => setPicking(null)}
          onSubmit={(owner) => addPicked(picking, owner)}
        />
      )}

      {dialog && (
        <AddDialog
          kind={dialog.kind}
          title={dialog.title}
          under={dialog.ball?.label ?? null}
          initialName={dialog.name}
          onCancel={() => setDialog(null)}
          onSubmit={async (values) => {
            await add(dialog, values);
          }}
        />
      )}
    </div>
  );
}
