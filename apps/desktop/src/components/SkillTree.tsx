import "@xyflow/react/dist/style.css";

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "../lib/api";
import { providerLabel } from "../lib/format";
import { providerForName, providerInfo } from "../lib/providers";
import {
  STATE_FIELD,
  buildTree,
  dropTarget,
  findPrimary,
  initialLit,
  layout,
  newCategoryId,
  parseState,
  pathTo,
  placeAccount,
  serializeState,
  setStatus,
  shortId,
  toggleLit,
  walk,
  type NodeKind,
  type Primary,
  type SkillData,
  type Status,
  type TreeItem,
  type TreeState,
} from "../lib/skillTree";
import type { Account, CustomField, SecretKind, SecretListing } from "../lib/types";

import {
  AddDialog,
  ContextMenu,
  KIND_LABEL,
  Palette,
  SkillEdge,
  SkillNode,
  STATUS_LABEL,
  type AddKind,
  type AddValues,
  type MenuItem,
  type PaletteEntry,
  type SkillEdgeData,
  type SkillFlowNode,
} from "./SkillTreeParts";
import ProviderIcon from "./ProviderIcon";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
  /** Show only what this project uses. Omit to let the user pick at the top. */
  projectId?: string | null;
}

const nodeTypes = { skill: SkillNode };
// Fitting a tree of one node would otherwise zoom it to fill the screen.
const FIT_MAX_ZOOM = 1.1;

/** Roughly how big each kind of node draws, before it is measured. */
const INITIAL_SIZE: Record<NodeKind, { width: number; height: number }> = {
  primary: { width: 120, height: 120 },
  identity: { width: 150, height: 40 },
  category: { width: 150, height: 46 },
  account: { width: 170, height: 40 },
  field: { width: 150, height: 36 },
  project: { width: 150, height: 44 },
};
const edgeTypes = { skill: SkillEdge };

const SECRET_KIND: Record<"api" | "password" | "secret", SecretKind> = {
  api: "generic_api_key",
  password: "password",
  secret: "env_var",
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function loadData(): Promise<SkillData> {
  const [people, secrets, attention, resources, projects] = await Promise.all([
    api.ledgerOverview(),
    api.listAllSecrets(),
    api.needsAttention(),
    api.listServiceProjects(),
    api.listProjects(),
  ]);
  const identityFields = new Map<string, CustomField[]>();
  const accountFields = new Map<string, CustomField[]>();
  await Promise.all([
    ...people.map(async (p) =>
      identityFields.set(p.identity.id, await api.customFields({ kind: "identity", id: p.identity.id })),
    ),
    ...people.flatMap((p) =>
      p.accounts.map(async (a) =>
        accountFields.set(a.account.id, await api.customFields({ kind: "account", id: a.account.id })),
      ),
    ),
  ]);
  return {
    people,
    secrets,
    attention,
    resources,
    identityFields,
    accountFields,
    projects: projects.map((p) => ({ id: p.project.id, name: p.project.name })),
  };
}

/**
 * The Ledger as a passive skill tree.
 *
 * The primary identity sits in the middle; around it the user's own categories,
 * then accounts, then each account's keys, passwords and fields. Click lights a
 * branch and opens it, right-click adds, renames, copies and deletes, double
 * click renames in place, and Cmd/Ctrl+K finds anything. Every change goes
 * through the same backend calls as the rest of the app; the only thing the
 * tree stores of its own is the category list, in a hidden field of the vault.
 */
export default function SkillTree(props: Props) {
  return (
    <ReactFlowProvider>
      <SkillTreeCanvas {...props} />
    </ReactFlowProvider>
  );
}

type Dialog = { kind: AddKind; parent: TreeItem };

function SkillTreeCanvas({ onNotify, onChanged, refreshKey, projectId }: Props) {
  const flow = useReactFlow();
  const [data, setData] = useState<SkillData | null>(null);
  const [state, setState] = useState<TreeState>({ categories: [], statuses: {} });
  const [filter, setFilter] = useState<string | null>(projectId ?? null);
  const [lit, setLit] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key: string | null } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [palette, setPalette] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  // A node to light and select once the tree has been rebuilt with it in --
  // after an add, the new node does not exist until the reload lands.
  const [pending, setPending] = useState<string | null>(null);
  // A node to bring into view once it has a position.
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => setFilter(projectId ?? null), [projectId]);

  const reload = useCallback(async () => {
    try {
      const next = await loadData();
      const primary = findPrimary(next);
      setData(next);
      setState(parseState(primary?.field?.value));
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }, [onNotify]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const primary: Primary | null = useMemo(() => (data ? findPrimary(data) : null), [data]);
  const root = useMemo(
    () => (data ? buildTree(data, state, primary, filter) : null),
    [data, state, primary, filter],
  );
  // The full tree, unfiltered, is what the palette searches.
  const fullRoot = useMemo(
    () => (data && filter ? buildTree(data, state, primary, null) : root),
    [data, state, primary, filter, root],
  );

  const litSet = useMemo(() => lit ?? (root ? initialLit(root) : new Set<string>()), [lit, root]);
  const placed = useMemo(() => (root ? layout(root, litSet) : []), [root, litSet]);
  const byKey = useMemo(() => new Map(placed.map((p) => [p.item.key, p])), [placed]);

  useEffect(() => {
    if (!pending || !root) return;
    const trail = pathTo(root, pending);
    if (trail.length === 0) return;
    setLit((current) => {
      const next = new Set(current ?? initialLit(root));
      for (const k of trail) next.add(k);
      return next;
    });
    setSelected(pending);
    setFocus(pending);
    setPending(null);
  }, [pending, root]);

  useEffect(() => {
    const at = focus ? byKey.get(focus) : undefined;
    if (!at) return;
    setFocus(null);
    void flow.setCenter(at.x, at.y, { zoom: Math.max(flow.getZoom(), 0.9), duration: 450 });
  }, [focus, byKey, flow]);

  const changed = useCallback(async () => {
    await reload();
    onChanged();
  }, [reload, onChanged]);

  // --- persistence of the hidden field ------------------------------------------

  const saveState = useCallback(
    async (next: TreeState, on: string | null = primary?.identityId ?? null) => {
      if (!on) throw new Error("Add your email first: categories belong to the primary identity.");
      const previous = state;
      setState(next);
      try {
        const value = serializeState(next);
        if (primary?.field && primary.identityId === on) {
          await api.updateCustomField(primary.field.id, STATE_FIELD, value);
        } else {
          await api.addCustomField({ kind: "identity", id: on }, STATE_FIELD, value);
          if (primary?.field) await api.deleteCustomField(primary.field.id);
        }
        await reload();
      } catch (e: unknown) {
        setState(previous);
        throw e;
      }
    },
    [primary, state, reload],
  );

  // --- lookups -------------------------------------------------------------------------

  const item = useCallback(
    (key: string | null): TreeItem | null =>
      key && fullRoot ? (walk(fullRoot).find((w) => w.item.key === key)?.item ?? null) : null,
    [fullRoot],
  );

  const accountById = useCallback(
    (id: string): Account | null => {
      for (const p of data?.people ?? []) {
        const hit = p.accounts.find((a) => a.account.id === id);
        if (hit) return hit.account;
      }
      return null;
    },
    [data],
  );

  const secretById = useCallback(
    (id: string): SecretListing | null => data?.secrets.find((s) => s.entry.secret.id === id) ?? null,
    [data],
  );

  const parentOf = useCallback(
    (key: string): TreeItem | null => {
      if (!fullRoot) return null;
      const trail = pathTo(fullRoot, key);
      return item(trail[trail.length - 2] ?? null);
    },
    [fullRoot, item],
  );

  // --- actions -----------------------------------------------------------------------------

  async function copy(target: TreeItem) {
    try {
      if (target.source === "secret" && target.id) {
        // Rust writes the value to the clipboard; it never enters JavaScript.
        await api.copySecret(target.id);
        onNotify(`Copied ${target.label} (${target.sub ?? "••••"}) · clipboard clears in 30 seconds`);
      } else if (target.sub) {
        await writeText(target.sub);
        onNotify(`Copied ${target.label}`);
      }
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function rename(key: string, raw: string | null) {
    setRenaming(null);
    const target = item(key);
    const value = raw?.trim();
    if (!target || !value) return;
    try {
      switch (target.kind) {
        case "category":
          if (value === target.label) return;
          await saveState({
            ...state,
            categories: state.categories.map((c) => (c.id === target.id ? { ...c, name: value } : c)),
          });
          break;
        case "primary":
        case "identity":
          if (target.id) await api.updateIdentity(target.id, value);
          break;
        case "account": {
          const account = target.id ? accountById(target.id) : null;
          if (!account || value === account.label) return;
          await api.updateAccount(account.id, value, {
            login_email: account.login_email,
            username: account.username,
            url: account.url,
            notes: account.notes,
          });
          break;
        }
        case "project":
          if (target.id && value !== target.label) await api.updateProject(target.id, value, null);
          break;
        case "field": {
          if (value === target.label || !target.id) return;
          if (target.source === "secret") {
            const s = secretById(target.id)?.entry.secret;
            if (s) await api.updateSecretMeta(s.id, value, s.environment, s.notes);
          } else if (target.source === "custom") {
            const f = data?.accountFields
              ? [...data.accountFields.values()].flat().find((x) => x.id === target.id)
              : undefined;
            if (f) await api.updateCustomField(f.id, value, f.value);
          } else {
            return;
          }
          break;
        }
      }
      onNotify(`Renamed to ${value}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function remove(target: TreeItem) {
    try {
      switch (target.kind) {
        case "category":
          if (!window.confirm(`Remove the category "${target.label}"? Its accounts stay in your vault.`)) return;
          await saveState({ ...state, categories: state.categories.filter((c) => c.id !== target.id) });
          break;
        case "account":
          if (
            !target.id ||
            !window.confirm(
              `Delete the ${target.label} account and the ${target.children.length} fields under it? This cannot be undone.`,
            )
          )
            return;
          await api.deleteAccount(target.id);
          break;
        case "identity":
          if (!target.id || !window.confirm(`Delete ${target.label} and every account under it?`)) return;
          await api.deleteIdentity(target.id);
          break;
        case "project":
          if (!target.id || !window.confirm(`Delete the project ${target.label} and its own variables?`)) return;
          await api.deleteProject(target.id);
          setFilter(null);
          break;
        case "field": {
          if (!target.id) return;
          if (target.source === "secret") {
            if (!window.confirm(`Delete ${target.label}? The stored value cannot be recovered.`)) return;
            await api.deleteSecret(target.id);
          } else if (target.source === "custom") {
            if (!window.confirm(`Remove the field "${target.label}"?`)) return;
            await api.deleteCustomField(target.id);
          } else {
            const account = accountById(target.id);
            if (!account) return;
            const which = target.key.split(":")[2];
            await api.updateAccount(account.id, account.label, {
              login_email: which === "login_email" ? null : account.login_email,
              username: which === "username" ? null : account.username,
              url: account.url,
              notes: account.notes,
            });
          }
          break;
        }
        case "primary":
          return;
      }
      if (selected === target.key) setSelected(null);
      onNotify(`Removed ${target.label}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function makePrimary(target: TreeItem) {
    if (!target.id) return;
    try {
      await saveState(state, target.id);
      setLit(null);
      onNotify(`${target.label} is now the primary identity`);
      onChanged();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function status(target: TreeItem, next: Status | null) {
    const id = target.kind === "category" ? target.id : target.id ? shortId(target.id) : null;
    if (!id) return;
    try {
      await saveState(setStatus(state, id, next));
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function add(kind: AddKind, parent: TreeItem, values: AddValues) {
    switch (kind) {
      case "identity": {
        const identity = await api.createIdentityManual(values.label || values.name, values.name);
        await saveState(state, identity.id);
        onNotify(`Added ${values.name} as your primary identity`);
        break;
      }
      case "category": {
        const next: TreeState = {
          ...state,
          categories: [...state.categories, { id: newCategoryId(state), name: values.name, accounts: [] }],
        };
        await saveState(next);
        onNotify(`Added category ${values.name}`);
        break;
      }
      case "account": {
        const identityId = parent.kind === "identity" ? parent.id : primary?.identityId;
        if (!identityId) throw new Error("Add your email first.");
        const provider = providerForName(values.name);
        // The account is called what was typed -- "Claude", not "Anthropic" --
        // in the registry's spelling when it is the registry's own name.
        const info = providerInfo(provider);
        const typed = values.name.charAt(0).toUpperCase() + values.name.slice(1);
        const label =
          values.label || (info && info.name.toLowerCase() === values.name.toLowerCase() ? info.name : typed);
        const account = await api.createAccountManual(identityId, provider, label);
        if (parent.kind === "category" && parent.id) {
          await saveState(placeAccount(state, account.id, parent.id));
        } else {
          await reload();
        }
        setPending(`account:${account.id}`);
        const service = providerLabel(provider);
        onNotify(service === label ? `Added ${label}` : `Added ${label} (${service})`);
        break;
      }
      case "api":
      case "password":
      case "secret": {
        const owner =
          parent.kind === "project"
            ? { project_id: parent.id, service_project_id: null, account_id: null }
            : { project_id: null, service_project_id: null, account_id: parent.id };
        const record = await api.storeSecret(
          { owner, kind: SECRET_KIND[kind], name: values.name, environment: "unknown", notes: null },
          values.value,
        );
        await reload();
        setPending(`secret:${record.id}`);
        onNotify(`Saved ${values.name} · encrypted in your vault`);
        break;
      }
      case "field": {
        if (!parent.id) return;
        await api.addCustomField({ kind: "account", id: parent.id }, values.name, values.value);
        await reload();
        setPending(parent.key);
        onNotify(`Added ${values.name}`);
        break;
      }
      case "project": {
        const existing = data?.projects.find((p) => p.name.toLowerCase() === values.name.toLowerCase());
        const project = existing ?? (await api.createProject(values.name, null));
        if (parent.kind === "account" && parent.id) {
          // "This account is used by that project" is recorded the way the rest
          // of DevLedger records it: a resource under the account, linked.
          const account = accountById(parent.id);
          const resource = await api.createServiceProjectManual(
            parent.id,
            null,
            account?.provider ?? "unknown",
            project.name,
            null,
            "unknown",
          );
          await api.linkServiceProject(resource.id, project.id);
          onNotify(`${parent.label} is now used by ${project.name}`);
        } else {
          onNotify(existing ? `${project.name} already exists` : `Added project ${project.name}`);
        }
        break;
      }
    }
    setDialog(null);
    await changed();
  }

  // --- the menu for a node -------------------------------------------------------------------

  const statusItems = (target: TreeItem): MenuItem[] => [
    ...(["healthy", "missing", "attention"] as Status[]).map((s) => ({
      label: STATUS_LABEL[s],
      checked: target.status === s,
      onSelect: () => void status(target, s),
    })),
    { label: "Work it out", onSelect: () => void status(target, null) },
  ];

  const copyItems = (target: TreeItem): MenuItem[] =>
    target.children
      .filter((c) => c.kind === "field")
      .map((f) => ({
        label: f.label,
        hint: f.source === "secret" ? (f.sub ?? "••••") : undefined,
        onSelect: () => void copy(f),
      }));

  // Everyone an account could be moved to: people with an email address.
  // With `accountId`, moves that account; without, every account of `except`.
  const moveTargets = (except: string | null, accountId?: string): MenuItem[] =>
    (data?.people ?? [])
      .filter((p) => p.identity.id !== except && p.identity.email)
      .map((p) => ({
        label: p.identity.email ?? p.identity.label,
        onSelect: () =>
          void moveAccounts(except, p.identity.id, p.identity.email ?? p.identity.label, accountId),
      }));

  /** Move one account, or with `accountId` null every account of `from`, to a person. */
  async function moveAccounts(from: string | null, to: string, toLabel: string, accountId?: string) {
    try {
      const ids = accountId
        ? [accountId]
        : (data?.people.find((p) => p.identity.id === from)?.accounts ?? []).map((a) => a.account.id);
      for (const id of ids) await api.moveAccount(id, to);
      onNotify(ids.length === 1 ? `Moved to ${toLabel}` : `Moved ${ids.length} accounts to ${toLabel}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  function menuFor(target: TreeItem | null): { title: string; items: MenuItem[] } {
    const open = (kind: AddKind, parent: TreeItem) => () => setDialog({ kind, parent });
    if (!target) {
      const centre = root;
      if (!centre) {
        return { title: "Ledger", items: [{ label: "Add your email", onSelect: () => setDialog({ kind: "identity", parent: EMPTY }) }] };
      }
      return {
        title: "Ledger",
        items: [
          { label: "Add", items: [
            { label: "Category", onSelect: open("category", centre) },
            { label: "Account", onSelect: open("account", centre) },
            { label: "Project", onSelect: open("project", centre) },
          ] },
          { label: "Find…", hint: "⌘K", onSelect: () => setPalette(true) },
        ],
      };
    }
    const rename = { label: "Rename", hint: "double-click", onSelect: () => setRenaming(target.key) };
    const del = (label = "Delete"): MenuItem => ({ label, danger: true, onSelect: () => void remove(target) });
    switch (target.kind) {
      case "primary":
        return {
          title: target.label,
          items: [
            { label: "Add", items: [
              { label: "Category", onSelect: open("category", target) },
              { label: "Account", onSelect: open("account", target) },
              { label: "Project", onSelect: open("project", target) },
            ] },
            { label: "Copy email", onSelect: () => void copy({ ...target, sub: target.label }) },
            { label: "Rename", hint: "your name", onSelect: () => setRenaming(target.key) },
            ...(primary?.marked ? [] : [{ label: "Make Primary", onSelect: () => void makePrimary(target) }]),
            { label: "Status", items: statusItems(target) },
          ],
        };
      case "identity":
        return {
          title: target.label,
          items: [
            { label: "Add", items: [{ label: "Account", onSelect: open("account", target) }] },
            { label: "Make Primary", onSelect: () => void makePrimary(target) },
            { label: "Move all accounts to", items: moveTargets(target.id) },
            rename,
            { label: "Status", items: statusItems(target) },
            del(),
          ],
        };
      case "category":
        return {
          title: target.label,
          items: [
            { label: "Add", items: [{ label: "Account", onSelect: open("account", target) }] },
            rename,
            { label: "Status", items: statusItems(target) },
            del("Remove category"),
          ],
        };
      case "account":
        return {
          title: target.label,
          items: [
            { label: "Add", items: [
              { label: "API key", onSelect: open("api", target) },
              { label: "Password", onSelect: open("password", target) },
              { label: "Secret", onSelect: open("secret", target) },
              { label: "Field", onSelect: open("field", target) },
              { label: "Project", hint: "used by", onSelect: open("project", target) },
            ] },
            { label: "Copy", items: copyItems(target) },
            {
              label: "Move to",
              items: moveTargets(
                target.id ? (accountById(target.id)?.identity_id ?? null) : null,
                target.id ?? undefined,
              ),
            },
            rename,
            { label: "Status", items: statusItems(target) },
            del(),
          ],
        };
      case "project":
        return {
          title: target.label,
          items: [
            { label: "Add", items: [{ label: "Variable", onSelect: open("secret", target) }] },
            rename,
            del("Delete project"),
          ],
        };
      case "field":
        return {
          title: target.label,
          items: [
            { label: "Copy", hint: target.source === "secret" ? (target.sub ?? "••••") : undefined, onSelect: () => void copy(target) },
            ...(target.source === "detail" ? [] : [rename]),
            ...(target.source === "detail" ? [] : [{ label: "Status", items: statusItems(target) }]),
            del(target.source === "detail" ? "Clear" : "Delete"),
          ],
        };
    }
  }

  // --- xyflow wiring --------------------------------------------------------------------------

  // Nodes are memoised; they call the latest `rename` through a ref so a
  // rename never works on the data as it was when the node was drawn.
  const renameRef = useRef(rename);
  renameRef.current = rename;
  const onRename = useCallback((key: string, value: string | null) => void renameRef.current(key, value), []);

  const nodes: SkillFlowNode[] = useMemo(
    () =>
      placed.map((p) => ({
        id: p.item.key,
        type: "skill" as const,
        position:
          drag && drag.id === p.item.key ? { x: drag.x, y: drag.y } : { x: p.x, y: p.y },
        // A size to draw with until the node has been measured. xyflow hides
        // a node it has no size for, and a measurement that lands late left
        // the whole canvas empty -- rarely, but Fit could not find it either.
        initialWidth: INITIAL_SIZE[p.item.kind].width,
        initialHeight: INITIAL_SIZE[p.item.kind].height,
        draggable: p.item.kind === "account",
        selectable: false,
        data: {
          item: p.item,
          lit: litSet.has(p.item.key),
          selected: selected === p.item.key,
          renaming: renaming === p.item.key,
          pulsing: p.item.kind === "identity" && p.item.sub === "No email",
          onRename,
        },
      })),
    [placed, litSet, selected, renaming, drag, onRename],
  );

  const edges: Edge<SkillEdgeData>[] = useMemo(
    () =>
      placed
        .filter((p) => p.parent)
        .map((p) => ({
          id: `${p.parent}->${p.item.key}`,
          source: p.parent as string,
          target: p.item.key,
          type: "skill",
          data: { lit: litSet.has(p.item.key) && litSet.has(p.parent as string) },
          selectable: false,
        })),
    [placed, litSet],
  );

  const onNodeClick: NodeMouseHandler<SkillFlowNode> = (_, node) => {
    if (!root || renaming) return;
    setLit(toggleLit(root, litSet, node.id));
    setSelected(node.id);
  };

  const onNodeContextMenu: NodeMouseHandler<SkillFlowNode> = (event, node) => {
    event.preventDefault();
    setSelected(node.id);
    setMenu({ x: event.clientX, y: event.clientY, key: node.id });
  };

  // Dropping an account on a category files it there; on the centre, takes it
  // out of its category; on another person, moves the account to them.
  async function onDragStop(_: unknown, node: Node) {
    setDrag(null);
    const hit = dropTarget(placed, node.position.x, node.position.y, node.id);
    const target = hit ? item(hit.item.key) : null;
    const accountId = node.id.startsWith("account:") ? node.id.slice("account:".length) : null;
    if (!target || !accountId) return;
    try {
      if (target.kind === "category" && target.id) {
        await saveState(placeAccount(state, accountId, target.id));
        onNotify(`Moved to ${target.label}`);
      } else if (target.kind === "primary") {
        await saveState(placeAccount(state, accountId, null));
      } else if (target.kind === "identity" && target.id) {
        const account = accountById(accountId);
        if (account?.identity_id === target.id) return;
        if (!window.confirm(`Move ${account?.label ?? "this account"} to ${target.label}?`)) return;
        await api.moveAccount(accountId, target.id);
        onNotify(`Moved to ${target.label}`);
        await changed();
      }
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  // Cmd/Ctrl+K anywhere on this screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paletteEntries: PaletteEntry[] = useMemo(() => {
    const entries: PaletteEntry[] = (data?.projects ?? []).map((p) => ({
      key: `project:${p.id}`,
      kind: "project",
      label: p.name,
      sub: "Project",
    }));
    if (fullRoot) {
      for (const w of walk(fullRoot)) {
        if (w.item.kind === "project") continue;
        entries.push({ key: w.item.key, kind: w.item.kind, label: w.item.label, sub: w.item.sub });
      }
    }
    return entries;
  }, [data, fullRoot]);

  function pick(entry: PaletteEntry) {
    setPalette(false);
    if (entry.kind === "project") {
      setFilter(entry.key.slice("project:".length));
      setLit(null);
      window.setTimeout(() => void flow.fitView({ duration: 400, padding: 0.2, maxZoom: FIT_MAX_ZOOM }), 50);
      return;
    }
    setFilter(null);
    setPending(entry.key);
  }

  // --- render ------------------------------------------------------------------------------------

  if (!data) return <div className="empty">Loading…</div>;

  const menuTarget = menu?.key ? item(menu.key) : null;
  const built = menu ? menuFor(menuTarget) : null;
  const selectedItem = item(selected);
  const projects = data.projects;

  return (
    <div className="skilltree" onContextMenu={(e) => e.preventDefault()}>
      <div className="st-toolbar">
        {projectId === undefined && (
          <div className="st-projects" role="group" aria-label="Filter by project">
            <button type="button" className={filter === null ? "active" : ""} onClick={() => setFilter(null)}>
              All projects
            </button>
            {projects.map((p) => (
              <button
                type="button"
                key={p.id}
                className={filter === p.id ? "active" : ""}
                onClick={() => {
                  setFilter(filter === p.id ? null : p.id);
                  setLit(null);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <button type="button" className="st-find" onClick={() => setPalette(true)}>
          Find <kbd>⌘K</kbd>
        </button>
      </div>

      {!root ? (
        <div className="st-empty">
          <p>Your tree starts with your email address.</p>
          <button type="button" className="primary" onClick={() => setDialog({ kind: "identity", parent: EMPTY })}>
            Add your email
          </button>
        </div>
      ) : (
        <ReactFlow<SkillFlowNode, Edge<SkillEdgeData>>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(_, node) => {
            const t = item(node.id);
            if (t && !(t.kind === "field" && t.source === "detail")) setRenaming(node.id);
          }}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, key: null });
          }}
          onPaneClick={() => setSelected(null)}
          onNodeDrag={(_, node) => setDrag({ id: node.id, x: node.position.x, y: node.position.y })}
          onNodeDragStop={(e, node) => void onDragStop(e, node)}
          nodeOrigin={[0.5, 0.5]}
          // Double-click renames; the zoom handler would swallow it first.
          zoomOnDoubleClick={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.2}
          maxZoom={3}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: FIT_MAX_ZOOM }}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} color="#1A1A1A" bgColor="#0A0A0A" gap={22} size={1.6} />
          <Controls
            showInteractive={false}
            position="bottom-left"
            fitViewOptions={{ padding: 0.25, maxZoom: FIT_MAX_ZOOM }}
          />
        </ReactFlow>
      )}

      {!primary?.marked && root && (
        <div className="st-hint">
          Right-click the centre and choose <strong>Make Primary</strong> to pin this identity.
        </div>
      )}

      {selectedItem && (
        <InfoPanel
          item={selectedItem}
          parent={parentOf(selectedItem.key)}
          account={selectedItem.kind === "account" && selectedItem.id ? accountById(selectedItem.id) : null}
          onClose={() => setSelected(null)}
          onCopy={(f) => void copy(f)}
          onStatus={(s) => void status(selectedItem, s)}
          onAdd={(kind) => setDialog({ kind, parent: selectedItem })}
        />
      )}

      {menu && built && (
        <ContextMenu x={menu.x} y={menu.y} title={built.title} items={built.items} onClose={() => setMenu(null)} />
      )}

      {palette && <Palette entries={paletteEntries} onPick={pick} onClose={() => setPalette(false)} />}

      {dialog && (
        <AddDialog
          kind={dialog.kind}
          parentLabel={dialog.parent === EMPTY ? null : dialog.parent.label}
          projectNames={projects.map((p) => p.name)}
          onCancel={() => setDialog(null)}
          onSubmit={(values) => add(dialog.kind, dialog.parent, values)}
        />
      )}
    </div>
  );
}

/** Stand-in parent for adding the very first identity. */
const EMPTY: TreeItem = {
  key: "empty",
  kind: "primary",
  label: "",
  sub: null,
  provider: null,
  tone: null,
  status: "healthy",
  id: null,
  source: null,
  children: [],
};

function InfoPanel({
  item,
  parent,
  account,
  onClose,
  onCopy,
  onStatus,
  onAdd,
}: {
  item: TreeItem;
  parent: TreeItem | null;
  account: Account | null;
  onClose: () => void;
  onCopy: (field: TreeItem) => void;
  onStatus: (status: Status) => void;
  onAdd: (kind: AddKind) => void;
}) {
  const fields = item.children.filter((c) => c.kind === "field");
  return (
    <aside className="st-info" aria-label="Details">
      <div className="st-info-head">
        {item.provider && <ProviderIcon provider={item.provider} size={20} />}
        <div>
          <div className="st-info-kind">{KIND_LABEL[item.kind]}</div>
          <div className="st-info-name">{item.label}</div>
        </div>
        <span className="spacer" />
        <button type="button" className="ghost" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>

      <dl className="st-info-list">
        {item.provider && (
          <>
            <dt>Service</dt>
            <dd>{providerLabel(item.provider)}</dd>
          </>
        )}
        {parent && (
          <>
            <dt>Under</dt>
            <dd>{parent.label}</dd>
          </>
        )}
        {account?.url && (
          <>
            <dt>Sign in at</dt>
            <dd>{account.url}</dd>
          </>
        )}
        {item.kind === "field" && item.sub && (
          <>
            <dt>Value</dt>
            <dd className={item.source === "secret" ? "mono" : ""}>{item.sub}</dd>
          </>
        )}
        {item.kind === "category" && (
          <>
            <dt>Accounts</dt>
            <dd>{item.children.length}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>
          <select
            aria-label="Status"
            value={item.status}
            onChange={(e) => onStatus(e.target.value as Status)}
            disabled={item.kind === "field" && item.source === "detail"}
          >
            {(["healthy", "missing", "attention"] as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </dd>
      </dl>

      {item.kind === "field" && (
        <button type="button" onClick={() => onCopy(item)}>
          Copy
        </button>
      )}

      {item.kind === "account" && (
        <>
          <h4>Fields</h4>
          {fields.length === 0 && <p className="muted-p">Nothing stored yet.</p>}
          {fields.map((f) => (
            <div key={f.key} className={`st-info-field tone-${f.tone ?? "plain"}`}>
              <span className="st-info-field-name">{f.label}</span>
              <span className={`st-info-field-value${f.source === "secret" ? " mono" : ""}`}>{f.sub}</span>
              <button type="button" onClick={() => onCopy(f)} aria-label={`Copy ${f.label}`}>
                Copy
              </button>
            </div>
          ))}
          <div className="st-info-actions">
            <button type="button" onClick={() => onAdd("api")}>
              + API key
            </button>
            <button type="button" onClick={() => onAdd("password")}>
              + Password
            </button>
            <button type="button" onClick={() => onAdd("field")}>
              + Field
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
