// The right-click menus, and the box that opens when a line is dragged into
// empty space. They only read the canvas and call its actions.

import { freeSpot, parseKey, besideSpot, type Ball, type Line, type Point } from "../../lib/canvas";
import { providerInfo } from "../../lib/providers";
import { type MenuItem } from "../CanvasParts";

import { COMMON, kindLabel, serviceName } from "./labels";
import { FIT, motion } from "./prefs";
import type { CanvasActions, CanvasCore, Dialog } from "./types";

export function canvasMenus(ctx: CanvasCore & CanvasActions) {
  const {
    accountBalls,
    addService,
    byKey,
    connect,
    copySecret,
    copyText,
    emails,
    flow,
    locked,
    makePrimary,
    model,
    onOpenProject,
    orgBalls,
    ownerOf,
    place,
    projectBalls,
    projectKey,
    remove,
    removeLine,
    resourceBalls,
    secretsOf,
    setDialog,
    setFinder,
    setMenu,
    setRenaming,
    setSelected,
    toggleLock,
  } = ctx;

  // --- menus --------------------------------------------------------------------------

  const serviceItems = (at: Point, owner: Ball | null): MenuItem[] => [
    ...COMMON.map((p) => {
      const info = providerInfo(p);
      return { label: info?.name ?? p, onSelect: () => void addService(p, info?.name ?? p, at, owner) };
    }),
    { label: "Other…", onSelect: () => setDialog({ kind: "service", ball: owner, at }) },
  ];

  function paneMenu(at: Point): { title: string; items: MenuItem[] } {
    const items: MenuItem[] = [];
    if (!locked) {
      if (!projectKey) items.push({ label: "Add email here", onSelect: () => setDialog({ kind: "email", ball: null, at }) });
      items.push({ label: "Add service here", items: serviceItems(at, null) });
      if (!projectKey) items.push({ label: "Add project here", onSelect: () => setDialog({ kind: "project", ball: null, at }) });
    }
    items.push({ label: "Find…", hint: "⌘K", onSelect: () => setFinder(true) });
    items.push({ label: "Fit to screen", onSelect: () => void flow.fitView({ ...FIT, duration: motion(300) }) });
    items.push({ label: locked ? "Edit map" : "Done editing", onSelect: toggleLock });
    return { title: "Map", items };
  }

  /** The add dialog for a project inside a service or organization. */
  const resourceDialog = (holder: Ball, at: Point | null): Dialog => ({
    kind: "resource",
    ball: holder,
    at,
    title: `Add a ${serviceName(holder)} project`,
  });

  /** Projects of yours not yet running on `target`, to pick from. */
  function useIn(target: Ball, at: Point): MenuItem {
    const using = new Set(model.lines.filter((l) => l.target === target.key).map((l) => l.source));
    return {
      label: "Use in project",
      items: [
        ...projectBalls.filter((p) => !using.has(p.key)).map((p) => ({ label: p.label, onSelect: () => void connect(target, p) })),
        { label: "New project…", onSelect: () => setDialog({ kind: "project", ball: target, at }) },
      ],
    };
  }

  function ballMenu(ball: Ball): { title: string; items: MenuItem[] } {
    const edit = !locked;
    const items: MenuItem[] = [{ label: "Show details", onSelect: () => setSelected(ball.key) }];
    const del: MenuItem = { label: "Delete", danger: true, onSelect: () => void remove(ball) };
    const rename_: MenuItem = { label: "Rename", hint: "double-click", onSelect: () => setRenaming(ball.key) };
    const field: MenuItem = { label: "Field…", onSelect: () => setDialog({ kind: "field", ball, at: null }) };
    const near = place.get(ball.key) ?? { x: 0, y: 0 };
    const beside = () => besideSpot(near, place.values());
    const keys = secretsOf(ball);
    if (keys.length > 0) {
      items.push({
        label: "Copy",
        items: keys.map((k) => ({ label: k.entry.secret.name, hint: k.entry.secret.preview, onSelect: () => void copySecret(k) })),
      });
    }
    if (ball.kind === "email") {
      if (!ball.noEmail) items.push({ label: "Copy email", onSelect: () => void copyText("the address", ball.label) });
      if (edit) {
        items.push({ label: "Add service", items: serviceItems(freeSpot({ x: near.x + 220, y: near.y }, place.values()), ball) });
        const works = new Set(model.lines.filter((l) => l.kind === "works" && l.source === ball.key).map((l) => l.target));
        items.push({
          label: "Works on",
          items: projectBalls.filter((p) => !works.has(p.key)).map((p) => ({ label: p.label, onSelect: () => void connect(ball, p) })),
        });
        items.push({ label: "Add", items: [field] });
        if (!ball.primary && !ball.noEmail) items.push({ label: "Make main email", onSelect: () => void makePrimary(ball) });
        items.push(rename_, del);
      }
    } else if (ball.kind === "account") {
      if (edit) {
        items.push({
          label: "Add",
          items: [
            { label: "Organization…", onSelect: () => setDialog({ kind: "org", ball, at: beside() }) },
            { label: `Project in ${ball.label}…`, onSelect: () => setDialog(resourceDialog(ball, beside())) },
            { label: "API key…", onSelect: () => setDialog({ kind: "api", ball, at: null }) },
            { label: "Password…", onSelect: () => setDialog({ kind: "password", ball, at: null }) },
            field,
          ],
        });
        items.push(useIn(ball, freeSpot({ x: near.x + 260, y: near.y }, place.values())));
        const owner = ownerOf(ball.id);
        items.push({
          label: "Move to email",
          items: emails.filter((e) => e.key !== owner?.key).map((e) => ({ label: e.label, onSelect: () => void connect(ball, e) })),
        });
        items.push(rename_, del);
      }
    } else if (ball.kind === "org") {
      if (edit) {
        items.push({ label: `Add project in ${ball.label}…`, onSelect: () => setDialog(resourceDialog(ball, beside())) });
        items.push({ label: "Add", items: [field] });
        const others = accountBalls.filter((a) => a.provider === ball.provider && a.key !== ball.parent);
        if (others.length > 0) {
          items.push({
            label: "Move to account",
            items: others.map((a) => ({ label: a.label, hint: ownerOf(a.id)?.label, onSelect: () => void connect(ball, a) })),
          });
        }
        items.push(rename_, del);
      }
    } else if (ball.kind === "resource") {
      if (edit) {
        items.push(useIn(ball, freeSpot({ x: near.x + 240, y: near.y }, place.values())));
        items.push({
          label: "Add",
          items: [
            { label: "API key…", onSelect: () => setDialog({ kind: "api", ball, at: null }) },
            { label: "Variable…", onSelect: () => setDialog({ kind: "secret", ball, at: null }) },
            field,
          ],
        });
        const holder = ball.parent ? byKey.get(ball.parent) : undefined;
        const account = holder?.kind === "org" ? (holder.parent ? byKey.get(holder.parent) : undefined) : holder;
        const moves: MenuItem[] = orgBalls
          .filter((o) => o.provider === ball.provider && o.key !== ball.parent)
          .map((o) => ({ label: o.label, hint: byKey.get(o.parent ?? "")?.label, onSelect: () => void connect(ball, o) }));
        if (holder?.kind === "org" && account) {
          moves.push({ label: `Out of ${holder.label}`, onSelect: () => void connect(ball, account) });
        }
        if (moves.length > 0) items.push({ label: "Move to organization", items: moves });
        items.push(rename_, del);
      }
    } else {
      if (onOpenProject && !projectKey) items.push({ label: "Open project", onSelect: () => onOpenProject(ball.id) });
      if (edit) {
        const used = new Set(model.lines.filter((l) => l.source === ball.key).map((l) => l.target));
        items.push({
          label: "Use a service",
          items: [...accountBalls, ...resourceBalls]
            .filter((a) => !used.has(a.key))
            .map((a) => ({
              label: a.label,
              hint: a.kind === "account" ? ownerOf(a.id)?.label : byKey.get(a.parent ?? "")?.label,
              onSelect: () => void connect(ball, a),
            })),
        });
        const people = new Set(model.lines.filter((l) => l.kind === "works" && l.target === ball.key).map((l) => l.source));
        items.push({
          label: "Who works on it",
          items: model.balls
            .filter((b) => b.kind === "email" && !people.has(b.key))
            .map((b) => ({ label: b.label, onSelect: () => void connect(ball, b) })),
        });
        items.push({
          label: "Add",
          items: [{ label: "Variable…", onSelect: () => setDialog({ kind: "secret", ball, at: null }) }, field],
        });
        items.push(rename_, { ...del, label: "Delete project" });
      }
    }
    return { title: `${kindLabel(ball)} · ${ball.label}`, items };
  }

  /**
   * A line dragged from a ball into empty space: what to add there. Where only
   * one thing makes sense, its form opens straight away.
   */
  function dropOn(from: Ball, at: Point, client: Point) {
    const open = (title: string, items: MenuItem[]) =>
      setMenu({ x: client.x, y: client.y, at, ball: null, line: null, title, items });
    switch (from.kind) {
      case "email":
        open(`New service for ${from.label}`, serviceItems(at, from));
        break;
      case "account":
        open(`Add to ${from.label}`, [
          { label: "Organization…", onSelect: () => setDialog({ kind: "org", ball: from, at }) },
          { label: `Project in ${from.label}…`, onSelect: () => setDialog(resourceDialog(from, at)) },
          { label: "A project of yours that uses it…", onSelect: () => setDialog({ kind: "project", ball: from, at }) },
        ]);
        break;
      case "org":
        setDialog(resourceDialog(from, at));
        break;
      case "resource":
        setDialog({ kind: "project", ball: from, at, title: `Your project that runs on ${from.label}` });
        break;
      case "project":
        open(`A service ${from.label} runs on`, [
          ...COMMON.map((p) => {
            const info = providerInfo(p);
            return { label: info?.name ?? p, onSelect: () => void addService(p, info?.name ?? p, at, null, from.id) };
          }),
          { label: "Other…", onSelect: () => setDialog({ kind: "service", ball: from, at }) },
        ]);
        break;
    }
  }

  function lineMenu(line: Line): { title: string; items: MenuItem[] } {
    const a = byKey.get(line.source)?.label ?? "";
    const b = byKey.get(line.target)?.label ?? "";
    if (line.kind === "owns") {
      const account = parseKey(line.target);
      const ball = account ? byKey.get(line.target) : null;
      return {
        title: `${b} belongs to ${a}`,
        items:
          locked || !ball
            ? [{ label: "Press Edit map to change this", disabled: true }]
            : [
                {
                  label: "Move to email",
                  items: emails.filter((e) => e.key !== line.source).map((e) => ({ label: e.label, onSelect: () => void connect(ball, e) })),
                },
              ],
      };
    }
    if (line.kind === "works") {
      return {
        title: `${a} works on ${b}`,
        items: locked
          ? [{ label: "Press Edit map to change this", disabled: true }]
          : [{ label: "Remove link", danger: true, onSelect: () => void removeLine(line) }],
      };
    }
    if (line.kind === "holds") {
      const inOrg = parseKey(line.source)?.kind === "org";
      return {
        title: `${b} is in ${a}`,
        items: locked
          ? [{ label: "Press Edit map to change this", disabled: true }]
          : inOrg
            ? [{ label: `Take out of ${a}`, danger: true, onSelect: () => void removeLine(line) }]
            : [{ label: `Drag ${b} to another ${inOrg ? "organization" : "account"} to move it`, disabled: true }],
      };
    }
    return {
      title: `${a} uses ${b}`,
      items: locked
        ? [{ label: "Press Edit map to change this", disabled: true }]
        : [{ label: "Remove link", danger: true, onSelect: () => void removeLine(line) }],
    };
  }

  return { serviceItems, paneMenu, resourceDialog, useIn, ballMenu, dropOn, lineMenu };
}
