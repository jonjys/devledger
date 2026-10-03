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
  neighbourhood,
  positions,
  savedPositions,
  type Ball,
  type Line,
  type Point,
} from "../lib/canvas";

import {
  AddDialog,
  BallView,
  ContextMenu,
  Finder,
  LineView,
  ballSize,
  type BallNode,
  type FindEntry,
  type LineData,
} from "./CanvasParts";
import { Details } from "./canvas/CanvasDetails";
import { Guide, HowItWorks } from "./canvas/CanvasHelp";
import { Shelf } from "./canvas/CanvasShelf";
import { canvasMenus } from "./canvas/canvasMenus";
import { load, type Loaded } from "./canvas/data";
import { useHistory } from "./canvas/history";
import { KIND_ORDER } from "./canvas/labels";
import { FIT, message, motion, readLocked } from "./canvas/prefs";
import type { CanvasCore, Dialog, Menu } from "./canvas/types";
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

const nodeTypes = { ball: BallView };
const edgeTypes = { line: LineView };

/**
 * The Ledger as a map you draw.
 *
 * Emails, the services you use and your projects are balls you place where you
 * like; lines between them are what the vault records -- which email owns a
 * service, which services a project runs on. Drag from a ball's port to
 * another ball to connect them, drag services in from the list on the right,
 * right-click anything, double-click to rename. Lock the map and nothing can be
 * moved, connected or deleted until it is unlocked again.
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
  // not change by accident. The one exception is an empty map, which is
  // being set up -- see the effect below.
  const [stored] = useState(readLocked);
  const [locked, setLocked] = useState(stored ?? true);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [finder, setFinder] = useState(false);
  const [help, setHelp] = useState(false);
  // Where balls have been dragged this session, on top of what the vault says.
  const [moved, setMoved] = useState<Map<string, Point>>(new Map());
  const [nodes, setNodes] = useState<BallNode[]>([]);

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
  const shown = useMemo(() => (projectKey ? neighbourhood(model.lines, projectKey) : null), [model, projectKey]);
  const balls = useMemo(() => (shown ? model.balls.filter((b) => shown.has(b.key)) : model.balls), [model, shown]);
  const lines = useMemo(
    () => (shown ? model.lines.filter((l) => shown.has(l.source) && shown.has(l.target)) : model.lines),
    [model, shown],
  );
  const byKey = useMemo(() => new Map(model.balls.map((b) => [b.key, b])), [model]);

  const place = useMemo(() => {
    const base =
      projectKey && data
        ? focusLayout(balls, lines, projectKey)
        : data
          ? positions(model.balls, savedPositions(data, model.balls))
          : new Map<string, Point>();
    for (const [k, p] of moved) base.set(k, p);
    return base;
  }, [data, model, balls, lines, projectKey, moved]);

  const lit = useMemo(() => (selected ? neighbourhood(model.lines, selected) : null), [model, selected]);

  // Nodes are memoised; they call the latest `rename` through a ref so a
  // rename never works on the data as it was when the ball was drawn.
  const renameRef = useRef<(key: string, value: string | null) => Promise<void>>(async () => undefined);
  const onRename = useCallback((key: string, value: string | null) => void renameRef.current(key, value), []);

  useEffect(() => {
    setNodes((prev) => {
      // A box- or shift-selection belongs to xyflow; keep it across redraws.
      const picked = new Set(locked ? [] : prev.filter((n) => n.selected).map((n) => n.id));
      return balls.map((b) => {
        const size = ballSize(b);
        return {
          id: b.key,
          type: "ball" as const,
          position: place.get(b.key) ?? { x: 0, y: 0 },
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
            renaming: renaming === b.key,
            locked,
            onRename,
          },
        };
      });
    });
  }, [balls, place, selected, lit, renaming, locked, onRename]);

  const edges: Edge<LineData>[] = useMemo(
    () =>
      lines.map((l) => ({
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
        },
      })),
    [lines, lit, selectedLine],
  );

  // Bring the whole map into view when it first has something on it. A
  // project's page lays itself out, so it refits as services are added; the
  // big map does not, because the user just put the new ball where they wanted.
  // Only once the balls have been measured: fitting earlier works from sizes
  // the canvas does not have yet and zooms far out.
  const shape = projectKey ? `${projectKey}|${balls.length}` : `map|${balls.length > 0}`;
  const measured = useNodesInitialized();
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (balls.length === 0 || !measured || fitted.current === shape) return;
    fitted.current = shape;
    // A frame later, once the canvas has also taken in its own size.
    const frame = window.requestAnimationFrame(() => void flow.fitView({ ...FIT, duration: motion(300) }));
    return () => window.cancelAnimationFrame(frame);
  }, [shape, measured, balls.length, flow]);

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
    focusOn,
    setPositions,
  } = actions;
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
    if (typing || dialog || finder) return;
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
  const findEntries: FindEntry[] = balls.map((b) => ({ key: b.key, kind: b.kind, label: b.label, sub: b.sub }));
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
        <ReactFlow<BallNode, Edge<LineData>>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes: NodeChange<BallNode>[]) => setNodes((n) => applyNodeChanges(changes, n))}
          onNodeDragStop={(_, node, dragged) => {
            // Several selected balls move together, and are put back together.
            const group = dragged.length > 0 ? dragged : [node];
            const before = new Map(group.map((n) => [n.id, place.get(n.id) ?? n.position]));
            const after = new Map(group.map((n) => [n.id, n.position]));
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
          onNodeClick={(_, node) => {
            setSelectedLine(null);
            setSelected((s) => (s === node.id ? null : node.id));
          }}
          onNodeDoubleClick={(_, node) => !locked && setRenaming(node.id)}
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
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
        {!empty && focusProject && lines.length === 0 && (
          <div className="cv-hint">
            Pick the services <strong>{focusProject.label}</strong> runs on from the list on the right, or drag them in.
          </div>
        )}
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
          connected={[...neighbourhood(model.lines, selectedBall.key)]
            // The projects inside it are shown as cards instead.
            .filter((k) => k !== selectedBall.key && !(k.startsWith("resource:") && byKey.get(k)?.parent === selectedBall.key))
            .map((k) => byKey.get(k))
            .filter((b): b is Ball => Boolean(b))
            // Services first, then projects, then emails; by name within each.
            .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label))}
          onClose={() => setSelected(null)}
          onPick={focusOn}
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
          locked={locked}
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
          onFind={focusOn}
          canvas={wrapRef}
          onPlace={(item, client) => {
            const at = client ? flow.screenToFlowPosition(client) : null;
            if (item.kind === "email") setDialog({ kind: "email", ball: null, at: at ?? spotInView() });
            else if (item.kind === "project") setDialog({ kind: "project", ball: null, at: at ?? spotInView() });
            else if (item.kind === "other") setDialog({ kind: "service", ball: null, at: at ?? spotInView(), name: item.name });
            else if (item.kind === "existing" && focusProject) {
              const a = byKey.get(item.key);
              if (a) void connect(focusProject, a);
            } else if (item.kind === "service") {
              // A click on a service you already have means that one; dragging
              // it onto the map is how a second account is added.
              const mine = accountBalls.filter((a) => a.provider === item.provider);
              const only = mine.length === 1 ? mine[0] : undefined;
              if (!at && only) {
                if (focusProject) void connect(focusProject, only);
                else {
                  focusOn(only.key);
                  onNotify(`You already have ${only.label}. Drag it onto the map to add a second account.`);
                }
              } else void addService(item.provider, item.name, at);
            }
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
            focusOn(entry.key);
          }}
          onClose={() => setFinder(false)}
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
