// What the canvas loads from the vault, and how a ball names the record it stands for.

import * as api from "../../lib/api";
import { ballKey, type Ball, type CanvasData } from "../../lib/canvas";
import type { Account, CustomField, EntityRef, Organization, ServiceProjectSummary } from "../../lib/types";

export const ENTITY: Record<Ball["kind"], EntityRef["kind"]> = {
  email: "identity",
  account: "account",
  org: "organization",
  resource: "service_project",
  project: "project",
};

export const entityOf = (ball: Ball): EntityRef => ({ kind: ENTITY[ball.kind], id: ball.id });

export interface Loaded extends CanvasData {
  accounts: Map<string, Account>;
  orgs: Map<string, Organization>;
  resourceById: Map<string, ServiceProjectSummary>;
}

export async function load(): Promise<Loaded> {
  const [people, projects, resources, secrets, attention, worksOn] = await Promise.all([
    api.ledgerOverview(),
    api.listProjects(),
    api.listServiceProjects(),
    api.listAllSecrets(),
    api.needsAttention(),
    api.identityProjectLinks(),
  ]);
  const fields = new Map<string, CustomField[]>();
  const accounts = new Map<string, Account>();
  const orgs = new Map<string, Organization>();
  const fetches: Promise<unknown>[] = [];
  const fetch = (key: string, entity: EntityRef) =>
    fetches.push(api.customFields(entity).then((f) => fields.set(key, f)));
  for (const p of people) {
    fetch(ballKey("email", p.identity.id), { kind: "identity", id: p.identity.id });
    for (const { account, organizations } of p.accounts) {
      accounts.set(account.id, account);
      fetch(ballKey("account", account.id), { kind: "account", id: account.id });
      for (const { organization } of organizations) {
        orgs.set(organization.id, organization);
        fetch(ballKey("org", organization.id), { kind: "organization", id: organization.id });
      }
    }
  }
  for (const r of resources) {
    fetch(ballKey("resource", r.service_project.id), { kind: "service_project", id: r.service_project.id });
  }
  for (const p of projects) fetch(ballKey("project", p.project.id), { kind: "project", id: p.project.id });
  await Promise.all(fetches);
  return {
    people,
    projects: projects.map((p) => ({ id: p.project.id, name: p.project.name })),
    resources,
    secrets,
    attention,
    fields,
    worksOn: worksOn ?? [],
    accounts,
    orgs,
    resourceById: new Map(resources.map((r) => [r.service_project.id, r])),
  };
}
