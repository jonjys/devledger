// Everything the canvas does to the vault: drawing and removing lines, adding,
// renaming and deleting, and saving where balls sit. Each change that can be
// taken back records a step for undo.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useMemo, useRef } from "react";

import * as api from "../../lib/api";
import {
  POS_FIELD,
  PRIMARY_FIELD,
  ballKey,
  connectIntent,
  formatPos,
  freeSpot,
  isHiddenField,
  isImplicit,
  nearestEmail,
  parseKey,
  posField,
  primaryField,
  resourceToLink,
  resourcesToUnlink,
  type Ball,
  type Line,
  type Point,
} from "../../lib/canvas";
import { providerForName } from "../../lib/providers";
import type {
  Account,
  CustomField,
  EntityRef,
  Provider,
  SecretListing,
  SecretOwner,
  ServiceProject,
} from "../../lib/types";
import { type AddValues } from "../CanvasParts";

import { entityOf } from "./data";
import { type Step } from "./history";
import { serviceLabel, serviceName } from "./labels";
import { message, motion, writeLocked } from "./prefs";
import type { Act, CanvasCore, Dialog } from "./types";

export function useCanvasActions(ctx: CanvasCore) {
  const {
    byKey,
    changed,
    data,
    flow,
    locked,
    model,
    onNotify,
    place,
    projectId,
    projectKey,
    record,
    renameRef,
    selected,
    setData,
    setDialog,
    setLocked,
    setMoved,
    setRenaming,
    setSelected,
    setSelectedLine,
    wrapRef,
  } = ctx;

  // --- history ----------------------------------------------------------------------

  // Undo and redo run long after the step was recorded, so everything they
  // touch reads the vault as it is now, through these, not as it was then.
  const dataRef = useRef(data);
  dataRef.current = data;
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const labelOf = (kind: Ball["kind"], id: string) => byKeyRef.current.get(ballKey(kind, id))?.label ?? "";

  // --- saving positions -------------------------------------------------------------

  async function savePosition(key: string, p: Point) {
    const d = dataRef.current;
    const ball = byKeyRef.current.get(key);
    if (!ball || !d || projectKey) return;
    const existing = posField(d, key);
    try {
      if (existing) {
        await api.updateCustomField(existing.id, POS_FIELD, formatPos(p));
      } else {
        const created = await api.addCustomField(entityOf(ball), POS_FIELD, formatPos(p));
        setData((cur) => {
          if (!cur) return cur;
          const fields = new Map(cur.fields);
          fields.set(key, [...(fields.get(key) ?? []), created]);
          return { ...cur, fields };
        });
      }
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function setPositions(to: Map<string, Point>) {
    setMoved((m) => {
      const next = new Map(m);
      for (const [k, p] of to) next.set(k, p);
      return next;
    });
    for (const [k, p] of to) await savePosition(k, p);
  }

  /** Put a ball that was just created where it was dropped. */
  async function placeNew(entity: EntityRef, at: Point | null) {
    if (!at || projectKey) return;
    try {
      await api.addCustomField(entity, POS_FIELD, formatPos(at));
    } catch {
      // It was made; it just lands in its column instead of where it was dropped.
    }
  }

  // --- lookups ----------------------------------------------------------------------

  const secretsOf = useCallback(
    (ball: Ball): SecretListing[] => {
      if (!data) return [];
      if (ball.kind === "project") return data.secrets.filter((s) => s.entry.secret.project_id === ball.id);
      if (ball.kind === "resource") return data.secrets.filter((s) => s.entry.secret.service_project_id === ball.id);
      if (ball.kind !== "account") return [];
      const mine = new Set(
        data.resources.filter((r) => r.service_project.account_id === ball.id).map((r) => r.service_project.id),
      );
      return data.secrets.filter(
        (s) =>
          s.entry.secret.account_id === ball.id ||
          (s.entry.secret.service_project_id !== null && mine.has(s.entry.secret.service_project_id)),
      );
    },
    [data],
  );

  const namedFields = useCallback(
    (ball: Ball): CustomField[] => (data?.fields.get(ball.key) ?? []).filter((f) => !isHiddenField(f.label)),
    [data],
  );

  const emails = useMemo(() => model.balls.filter((b) => b.kind === "email" && !b.noEmail), [model]);
  const projectBalls = useMemo(() => model.balls.filter((b) => b.kind === "project"), [model]);
  const accountBalls = useMemo(() => model.balls.filter((b) => b.kind === "account"), [model]);
  const orgBalls = useMemo(() => model.balls.filter((b) => b.kind === "org"), [model]);
  const resourceBalls = useMemo(() => model.balls.filter((b) => b.kind === "resource"), [model]);
  const ownerOf = (accountId: string) => {
    const owner = data?.accounts.get(accountId)?.identity_id;
    return owner ? byKey.get(ballKey("email", owner)) ?? null : null;
  };

  /** A spot near the middle of what is on screen that nothing sits on. */
  function spotInView(): Point {
    const rect = wrapRef.current?.getBoundingClientRect();
    const centre = rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width * 0.42, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    return freeSpot(centre, place.values());
  }

  // --- actions ------------------------------------------------------------------------

  async function connect(a: Ball, b: Ball) {
    if (!dataRef.current) return;
    const intent = connectIntent(a, b, model.lines);
    if (intent.kind === "refuse") {
      onNotify(intent.reason, true);
      return;
    }
    if (intent.kind === "none") return;
    try {
      const step: Step = {
        label: "the new line",
        undo: async () => undefined,
        redo: async () => {
          step.undo = await apply(intent);
        },
      };
      step.undo = await apply(intent);
      record(step);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  /** Carry out what a line means. Returns how to take it back. */
  async function apply(intent: Act): Promise<() => Promise<void>> {
    const d = dataRef.current;
    if (!d) throw new Error("The vault is not open.");
    switch (intent.kind) {
      case "own": {
        const before = d.accounts.get(intent.accountId)?.identity_id;
        await api.moveAccount(intent.accountId, intent.identityId);
        onNotify(`${labelOf("account", intent.accountId)} now belongs to ${labelOf("email", intent.identityId)}`);
        return async () => {
          if (before) await api.moveAccount(intent.accountId, before);
        };
      }
      case "use": {
        const made = await use(intent.accountId, intent.projectId);
        return async () => {
          if (made.created) await api.deleteServiceProject(made.resourceId);
          else await api.unlinkServiceProject(made.resourceId, intent.projectId);
        };
      }
      case "link": {
        await api.linkServiceProject(intent.resourceId, intent.projectId);
        // The line straight to the service said less than this one does. If
        // nothing is stored on what that line stood for, it goes.
        const account = d.resourceById.get(intent.resourceId)?.service_project.account_id;
        const dropped: ServiceProject[] = [];
        for (const r of account ? resourcesToUnlink(d, account, intent.projectId) : []) {
          if (!r.remove) continue;
          const sp = d.resourceById.get(r.id)?.service_project;
          await api.deleteServiceProject(r.id);
          if (sp) dropped.push(sp);
        }
        onNotify(`${labelOf("project", intent.projectId)} now runs on ${labelOf("resource", intent.resourceId)}`);
        return async () => {
          await api.unlinkServiceProject(intent.resourceId, intent.projectId);
          for (const sp of dropped) await relink(sp, intent.projectId);
        };
      }
      case "work":
        await api.linkIdentityProject(intent.identityId, intent.projectId);
        onNotify(`${labelOf("email", intent.identityId)} works on ${labelOf("project", intent.projectId)}`);
        return () => api.unlinkIdentityProject(intent.identityId, intent.projectId);
      case "moveOrg": {
        const before = d.orgs.get(intent.organizationId)?.account_id;
        await api.moveOrganization(intent.organizationId, intent.accountId);
        onNotify(`${labelOf("org", intent.organizationId)} is now under ${labelOf("account", intent.accountId)}`);
        return async () => {
          if (before) await api.moveOrganization(intent.organizationId, before);
        };
      }
      case "place": {
        const r = d.resourceById.get(intent.resourceId)?.service_project;
        if (!r) throw new Error("That project is no longer in your vault.");
        await placeResource(r.id, r.account_id, intent.accountId, intent.organizationId);
        const into = intent.organizationId ? labelOf("org", intent.organizationId) : labelOf("account", intent.accountId);
        onNotify(`${r.name} is now in ${into}`);
        return () => placeResource(r.id, intent.accountId, r.account_id, r.organization_id);
      }
    }
  }

  /** Put a resource under an organization, or straight under an account. */
  const placeResource = (id: string, fromAccount: string, toAccount: string, organizationId: string | null) =>
    fromAccount === toAccount
      ? api.assignOrganization(id, organizationId)
      : api.moveServiceProject(id, toAccount, organizationId);

  /** Bring back a resource a line stood for, and the line. */
  async function relink(sp: ServiceProject, projectId_: string) {
    const again = await api.createServiceProjectManual(sp.account_id, null, sp.provider, sp.name, null, sp.environment);
    await api.linkServiceProject(again.id, projectId_);
  }

  /**
   * Record that a project runs on a service: a resource under the account,
   * linked. `fresh` is an account created a moment ago, not in the data yet.
   */
  async function use(accountId: string, projectId_: string, fresh?: Account) {
    const d = dataRef.current;
    const account = fresh ?? d?.accounts.get(accountId);
    const project = d?.projects.find((p) => p.id === projectId_);
    if (!d || !account || !project) throw new Error("That service or project is no longer in your vault.");
    const existing = resourceToLink(d, accountId, project.name);
    const resourceId =
      existing ??
      (await api.createServiceProjectManual(accountId, null, account.provider, project.name, null, "unknown")).id;
    await api.linkServiceProject(resourceId, project.id);
    onNotify(`${project.name} now uses ${account.label}`);
    return { resourceId, created: existing === null };
  }

  async function removeLine(line: Line) {
    if (!dataRef.current || locked) return;
    const b = byKey.get(line.target)?.label;
    if (line.kind === "owns") {
      onNotify("A service always belongs to one email. Draw a line from it to another email to move it.");
      return;
    }
    if (line.kind === "holds" && parseKey(line.source)?.kind !== "org") {
      onNotify(
        parseKey(line.target)?.kind === "org"
          ? `${b} always belongs to a service. Draw it to another account to move it, or delete it.`
          : `${b} always belongs to a service. Draw it to an organization to put it there, or delete it.`,
      );
      return;
    }
    try {
      const step: Step = {
        label: "removing the line",
        undo: async () => undefined,
        redo: async () => {
          step.undo = await detach(line);
        },
      };
      step.undo = await detach(line);
      record(step);
      setSelectedLine(null);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  /** Take a line away. Returns how to put it back. */
  async function detach(line: Line): Promise<() => Promise<void>> {
    const d = dataRef.current;
    const from = parseKey(line.source);
    const to = parseKey(line.target);
    if (!d || !from || !to) throw new Error("That line is no longer on the map.");
    const a = labelOf(from.kind, from.id);
    const b = labelOf(to.kind, to.id);
    if (line.kind === "works") {
      await api.unlinkIdentityProject(from.id, to.id);
      onNotify(`${a} no longer works on ${b}`);
      return () => api.linkIdentityProject(from.id, to.id);
    }
    if (line.kind === "holds") {
      await api.assignOrganization(to.id, null);
      onNotify(`${b} is no longer in ${a}`);
      return () => api.assignOrganization(to.id, from.id);
    }
    if (to.kind === "resource") {
      await api.unlinkServiceProject(to.id, from.id);
      onNotify(`${a} no longer runs on ${b}`);
      return () => api.linkServiceProject(to.id, from.id);
    }
    const touched = resourcesToUnlink(d, to.id, from.id);
    const gone: ServiceProject[] = [];
    for (const r of touched) {
      if (r.remove) {
        const sp = d.resourceById.get(r.id)?.service_project;
        await api.deleteServiceProject(r.id);
        if (sp) gone.push(sp);
      } else {
        await api.unlinkServiceProject(r.id, from.id);
      }
    }
    onNotify(`${a} no longer uses ${b}`);
    return async () => {
      for (const r of touched) if (!r.remove) await api.linkServiceProject(r.id, from.id);
      for (const sp of gone) await relink(sp, from.id);
    };
  }

  /** A step that takes back something just added, while nothing is stored on it. */
  function added(label: string, kind: Ball["kind"], id: string, again: () => Promise<string | null>): Step {
    let current = id;
    return {
      label: `adding ${label}`,
      undo: () => removeIfEmpty(kind, current, label),
      redo: async () => {
        const next = await again();
        if (next) current = next;
      },
    };
  }

  /** Delete something undo is taking back -- unless it now holds something. */
  async function removeIfEmpty(kind: Ball["kind"], id: string, label: string) {
    const d = dataRef.current;
    if (!d) throw new Error("The vault is not open.");
    const busy = new Error(`${label} holds things now. Delete it from its menu instead.`);
    switch (kind) {
      case "email":
        if ([...d.accounts.values()].some((a) => a.identity_id === id)) throw busy;
        await api.deleteIdentity(id);
        return;
      case "account": {
        const holds =
          d.secrets.some((s) => s.entry.secret.account_id === id) ||
          [...d.orgs.values()].some((o) => o.account_id === id) ||
          d.resources.some(
            (r) => r.service_project.account_id === id && (r.secret_count > 0 || !isImplicit(r)),
          );
        if (holds) throw busy;
        await api.deleteAccount(id);
        return;
      }
      case "org":
        if (d.resources.some((r) => r.service_project.organization_id === id)) throw busy;
        await api.deleteOrganization(id);
        return;
      case "resource":
        if ((d.resourceById.get(id)?.secret_count ?? 0) > 0) throw busy;
        await api.deleteServiceProject(id);
        return;
      case "project": {
        if (d.secrets.some((s) => s.entry.secret.project_id === id)) throw busy;
        // The resources only its own lines stood for go with it.
        for (const r of d.resources) {
          if (isImplicit(r) && r.secret_count === 0 && r.used_by[0]?.id === id) {
            await api.deleteServiceProject(r.service_project.id);
          }
        }
        await api.deleteProject(id);
        return;
      }
    }
  }

  async function addService(
    provider: Provider,
    typed: string,
    at: Point | null,
    owner: Ball | null = null,
    forProject: string | null = projectId,
  ): Promise<string | null> {
    if (locked) return null;
    const spot = at ?? spotInView();
    const to = owner ?? nearestEmail(emails, place, spot);
    if (!to) {
      onNotify("Add your email first: every service belongs to an email.");
      setDialog({ kind: "email", ball: null, at: freeSpot({ x: spot.x - 300, y: spot.y }, place.values()) });
      return null;
    }
    try {
      const label = serviceLabel(typed, provider);
      const account = await api.createAccountManual(to.id, provider, label);
      await placeNew({ kind: "account", id: account.id }, spot);
      if (forProject) await use(account.id, forProject, account);
      else onNotify(`Added ${label} under ${to.label} · draw a line to another email to move it`);
      record(added(label, "account", account.id, () => addService(provider, typed, spot, to, forProject)));
      // The list stays open, so several services can be added in a row.
      await changed();
      return account.id;
    } catch (e: unknown) {
      onNotify(message(e), true);
      return null;
    }
  }

  /** Add what a dialog asked for. Returns the new thing's id, where it is a ball. */
  async function add(d: Dialog, values: AddValues): Promise<string | null> {
    const cur = dataRef.current;
    let made: { kind: Ball["kind"]; id: string; label: string } | null = null;
    switch (d.kind) {
      case "email": {
        const identity = await api.createIdentityManual(values.label || values.name, values.name);
        await placeNew({ kind: "identity", id: identity.id }, d.at);
        onNotify(`Added ${values.name}`);
        made = { kind: "email", id: identity.id, label: values.name };
        break;
      }
      case "project": {
        const existing = cur?.projects.find((p) => p.name.toLowerCase() === values.name.toLowerCase());
        if (existing) throw new Error(`There is already a project called ${existing.name}.`);
        const project = await api.createProject(values.name, null);
        await placeNew({ kind: "project", id: project.id }, d.at);
        if (d.ball?.kind === "resource") {
          await api.linkServiceProject(d.ball.id, project.id);
        } else if (d.ball?.kind === "account") {
          const resource = await api.createServiceProjectManual(
            d.ball.id,
            null,
            cur?.accounts.get(d.ball.id)?.provider ?? "unknown",
            project.name,
            null,
            "unknown",
          );
          await api.linkServiceProject(resource.id, project.id);
        }
        onNotify(`Added ${project.name} · draw a line from it to each service it runs on`);
        made = { kind: "project", id: project.id, label: project.name };
        break;
      }
      case "service":
        setDialog(null);
        return addService(
          providerForName(values.name),
          values.name,
          d.at,
          d.ball?.kind === "email" ? d.ball : null,
          d.ball?.kind === "project" ? d.ball.id : projectId,
        );
      case "org": {
        const account = d.ball ? cur?.accounts.get(d.ball.id) : undefined;
        if (!account) return null;
        const taken = [...(cur?.orgs.values() ?? [])].find(
          (o) => o.account_id === account.id && o.name.toLowerCase() === values.name.toLowerCase(),
        );
        if (taken) throw new Error(`${account.label} already has an organization called ${taken.name}.`);
        const org = await api.createOrganization(account.id, values.name);
        await placeNew({ kind: "organization", id: org.id }, d.at);
        onNotify(`Added ${org.name} in ${account.label} · drag from it to add its projects`);
        made = { kind: "org", id: org.id, label: org.name };
        break;
      }
      case "resource": {
        const org = d.ball?.kind === "org" ? cur?.orgs.get(d.ball.id) : undefined;
        const account = cur?.accounts.get(org?.account_id ?? d.ball?.id ?? "");
        if (!account) return null;
        const taken = cur?.resources.find(
          (r) =>
            r.service_project.account_id === account.id &&
            r.service_project.name.toLowerCase() === values.name.toLowerCase(),
        );
        if (taken) throw new Error(`${account.label} already has a project called ${taken.service_project.name}.`);
        const resource = await api.createServiceProjectManual(
          account.id,
          org?.id ?? null,
          account.provider,
          values.name,
          null,
          "unknown",
        );
        if (values.label) {
          await api.updateResource(resource.id, {
            name: resource.name,
            provider_ref: null,
            region: values.label,
            environment: resource.environment,
            url: null,
            notes: null,
          });
        }
        await placeNew({ kind: "service_project", id: resource.id }, d.at);
        onNotify(`Added ${resource.name} in ${org?.name ?? account.label} · draw a line from your project to it`);
        made = { kind: "resource", id: resource.id, label: resource.name };
        break;
      }
      case "api":
      case "password":
      case "secret": {
        if (!d.ball) return null;
        const owner: SecretOwner = {
          project_id: d.ball.kind === "project" ? d.ball.id : null,
          service_project_id: d.ball.kind === "resource" ? d.ball.id : null,
          account_id: d.ball.kind === "account" ? d.ball.id : null,
        };
        const kind = d.kind === "api" ? "generic_api_key" : d.kind === "password" ? "password" : "env_var";
        await api.storeSecret({ owner, kind, name: values.name, environment: "unknown", notes: null }, values.value);
        onNotify(`Saved ${values.name} · encrypted in your vault`);
        break;
      }
      case "field":
        if (!d.ball) return null;
        await api.addCustomField(entityOf(d.ball), values.name, values.value);
        onNotify(`Added ${values.name}`);
        break;
    }
    setDialog(null);
    if (made) {
      const what = made;
      record(added(what.label, what.kind, what.id, () => add(d, values)));
    }
    await changed();
    return made?.id ?? null;
  }

  /** What a ball is called now, in the terms a rename to `value` would change. */
  function nameOf(kind: Ball["kind"], id: string, value: string): string | null {
    const d = dataRef.current;
    if (!d) return null;
    switch (kind) {
      case "email": {
        const person = d.people.find((p) => p.identity.id === id)?.identity;
        return (value.includes("@") ? person?.email : person?.label) ?? null;
      }
      case "account":
        return d.accounts.get(id)?.label ?? null;
      case "org":
        return d.orgs.get(id)?.name ?? null;
      case "resource":
        return d.resourceById.get(id)?.service_project.name ?? null;
      case "project":
        return d.projects.find((p) => p.id === id)?.name ?? null;
    }
  }

  /** Rename to `value`. For an email, a value with an @ is a new address and anything else the person's name. */
  async function renameTo(kind: Ball["kind"], id: string, value: string) {
    const d = dataRef.current;
    if (!d) throw new Error("The vault is not open.");
    switch (kind) {
      case "email": {
        if (value.includes("@")) {
          const current = d.people.find((p) => p.identity.id === id)?.identity.email;
          // A new address: add it as the person's main one, drop the old.
          const old = (await api.identityEmails(id)).find((e) => e.address === current);
          await api.addIdentityEmail(id, value, true);
          if (old) await api.removeIdentityEmail(id, old.id);
        } else {
          await api.updateIdentity(id, value);
        }
        return;
      }
      case "account": {
        const account = d.accounts.get(id);
        if (!account) throw new Error("That service is no longer in your vault.");
        await api.updateAccount(id, value, {
          login_email: account.login_email,
          username: account.username,
          url: account.url,
          notes: account.notes,
        });
        return;
      }
      case "org":
        await api.renameOrganization(id, value);
        return;
      case "resource": {
        const r = d.resourceById.get(id)?.service_project;
        if (!r) throw new Error("That project is no longer in your vault.");
        await api.updateResource(id, {
          name: value,
          provider_ref: r.provider_ref,
          region: r.region,
          environment: r.environment,
          url: r.url,
          notes: r.notes,
        });
        return;
      }
      case "project":
        await api.updateProject(id, value, null);
        return;
    }
  }

  async function rename(key: string, raw: string | null) {
    setRenaming(null);
    const ball = byKey.get(key);
    const value = raw?.trim();
    if (!ball || !value || locked) return;
    const before = nameOf(ball.kind, ball.id, value);
    if (before === null || before === value) return;
    try {
      await renameTo(ball.kind, ball.id, value);
      record({
        label: `renaming ${before}`,
        undo: () => renameTo(ball.kind, ball.id, before),
        redo: () => renameTo(ball.kind, ball.id, value),
      });
      onNotify(`Renamed to ${value}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }
  renameRef.current = rename;

  async function remove(ball: Ball) {
    if (locked) return;
    try {
      if (ball.kind === "email") {
        const n = accountBalls.filter((a) => ownerOf(a.id)?.key === ball.key).length;
        const what = n > 0 ? ` and the ${n === 1 ? "service" : `${n} services`} under it` : "";
        if (!window.confirm(`Delete ${ball.label}${what}? This cannot be undone.`)) return;
        await api.deleteIdentity(ball.id);
      } else if (ball.kind === "account") {
        const n = secretsOf(ball).length;
        const what = n > 0 ? ` and the ${n === 1 ? "key" : `${n} keys`} stored under it` : "";
        if (!window.confirm(`Delete ${ball.label}${what}? This cannot be undone.`)) return;
        await api.deleteAccount(ball.id);
      } else if (ball.kind === "org") {
        const n = resourceBalls.filter((r) => r.parent === ball.key).length;
        const what = n > 0 ? ` The ${n === 1 ? "project" : `${n} projects`} in it stay, directly under ${serviceName(ball)}.` : "";
        if (!window.confirm(`Delete the organization ${ball.label}?${what}`)) return;
        await api.deleteOrganization(ball.id);
      } else if (ball.kind === "resource") {
        const n = secretsOf(ball).length;
        const what = n > 0 ? ` and the ${n === 1 ? "key" : `${n} keys`} stored on it` : "";
        if (!window.confirm(`Delete ${ball.label}${what} from your vault? This cannot be undone.`)) return;
        await api.deleteServiceProject(ball.id);
      } else {
        if (!window.confirm(`Delete the project ${ball.label} and its own variables? This cannot be undone.`)) return;
        await api.deleteProject(ball.id);
      }
      if (selected === ball.key) setSelected(null);
      onNotify(`Deleted ${ball.label}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function makePrimary(ball: Ball) {
    if (!data) return;
    try {
      const current = primaryField(data);
      await api.addCustomField({ kind: "identity", id: ball.id }, PRIMARY_FIELD, current?.value ?? "{}");
      if (current) await api.deleteCustomField(current.id);
      onNotify(`${ball.label} is now your main email`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function copySecret(listing: SecretListing) {
    try {
      // Rust writes the value to the clipboard; it never enters JavaScript.
      await api.copySecret(listing.entry.secret.id);
      onNotify(`Copied ${listing.entry.secret.name} · clipboard clears in 30 seconds`);
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function copyText(label: string, text: string) {
    try {
      await writeText(text);
      onNotify(`Copied ${label}`);
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  function toggleLock() {
    const next = !locked;
    setLocked(next);
    writeLocked(next);
    setRenaming(null);
    onNotify(
      next
        ? "Layout locked: nothing can be moved, connected or deleted"
        : "Editing the map: drag, connect, rename and delete. Press Done when you are finished.",
    );
  }

  function focusOn(key: string) {
    setSelected(key);
    const p = place.get(key);
    if (p) void flow.setCenter(p.x, p.y, { zoom: Math.max(flow.getZoom(), 0.9), duration: motion(400) });
  }

  return {
    savePosition,
    setPositions,
    secretsOf,
    namedFields,
    emails,
    projectBalls,
    accountBalls,
    orgBalls,
    resourceBalls,
    ownerOf,
    spotInView,
    connect,
    removeLine,
    addService,
    add,
    rename,
    remove,
    makePrimary,
    copySecret,
    copyText,
    toggleLock,
    focusOn,
  };
}
