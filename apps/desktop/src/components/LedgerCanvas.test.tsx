import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { CanvasData } from "../lib/canvas";
import type { CustomField, EntityRef, ProjectSummary } from "../lib/types";
import { AT, IDS, canvasVault, resource } from "../test/canvas-fixtures";
import LedgerCanvas from "./LedgerCanvas";

vi.mock("../lib/api");
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const mocked = vi.mocked(api);

// xyflow measures nodes with ResizeObserver and reads transforms through
// DOMMatrixReadOnly; jsdom has neither. These are the stand-ins xyflow's own
// testing guide gives.
beforeAll(() => {
  class ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      const contentRect = { width: 1200, height: 800, top: 0, left: 0, x: 0, y: 0, right: 1200, bottom: 800 };
      this.cb([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as globalThis.ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnly {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  vi.stubGlobal("ResizeObserver", ResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnly);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return 60; } },
    offsetWidth: { configurable: true, get() { return 60; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
});

function summary(id: string, name: string): ProjectSummary {
  return { project: { id, name, description: null, created_at: AT }, service_project_count: 0, secret_count: 0, providers: [] };
}

/** Serve a vault through the mocked API. */
function serve(data: CanvasData = canvasVault()) {
  mocked.ledgerOverview.mockImplementation(async () => data.people);
  mocked.listProjects.mockImplementation(async () => data.projects.map((p) => summary(p.id, p.name)));
  mocked.listServiceProjects.mockImplementation(async () => data.resources);
  mocked.listAllSecrets.mockImplementation(async () => data.secrets);
  mocked.needsAttention.mockImplementation(async () => data.attention);
  mocked.customFields.mockImplementation(async (entity: EntityRef): Promise<CustomField[]> => {
    const kind = { identity: "email", organization: "org", service_project: "resource" }[entity.kind as string] ?? entity.kind;
    return data.fields.get(`${kind}:${entity.id}`) ?? [];
  });
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mocked.addCustomField.mockImplementation(async (entity, label, value) => ({
    id: `f-${label}`,
    entity,
    label,
    value,
    position: 0,
    created_at: AT,
    updated_at: AT,
  }));
});

async function renderMap(props: Partial<Parameters<typeof LedgerCanvas>[0]> = {}) {
  const onNotify = vi.fn();
  const onChanged = vi.fn();
  render(<LedgerCanvas onNotify={onNotify} onChanged={onChanged} {...props} />);
  return { onNotify, onChanged };
}

const shelf = () => screen.getByRole("complementary", { name: "Add to the map" });

/** Press and release on a list item without moving: a click, as far as the list is concerned. */
function click(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(el, { clientX: 10, clientY: 10 });
}

describe("an empty map", () => {
  it("explains what to draw and starts with your email", async () => {
    serve({ ...canvasVault(), people: [], projects: [], resources: [], secrets: [], fields: new Map() });
    mocked.createIdentityManual.mockResolvedValue({ id: "new-me", label: "me", email: "me@example.com", email_blind_index: null, created_at: AT });
    const user = userEvent.setup();
    await renderMap();

    const guide = await screen.findByRole("region", { name: "Getting started" });
    expect(within(guide).getByText(/make-it-real/)).toBeInTheDocument();

    await user.click(within(guide).getByRole("button", { name: "Add your email" }));
    await user.type(screen.getByLabelText("Email address"), "me@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocked.createIdentityManual).toHaveBeenCalledWith("me@example.com", "me@example.com"));
    expect(mocked.addCustomField).toHaveBeenCalledWith({ kind: "identity", id: "new-me" }, "_pos", "0,0");
  });

  it("asks for an email before a service, since every service belongs to one", async () => {
    serve({ ...canvasVault(), people: [], projects: [], resources: [], secrets: [], fields: new Map() });
    const user = userEvent.setup();
    const { onNotify } = await renderMap();
    await screen.findByRole("region", { name: "Getting started" });

    click(within(shelf()).getByRole("button", { name: /GitHub/ }));
    expect(mocked.createAccountManual).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/email first/));
    expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });
});

describe("the map", () => {
  it("draws a ball for every email, service and project", async () => {
    serve();
    await renderMap();
    for (const key of [`email:${IDS.me}`, `email:${IDS.work}`, `account:${IDS.github}`, `project:${IDS.project}`, `project:${IDS.blog}`]) {
      expect(await screen.findByTestId(key)).toBeInTheDocument();
    }
  });

  it("adds a clicked service under the email, and says how to move it", async () => {
    const data = serve();
    data.people = data.people.filter((p) => p.identity.id === IDS.me);
    mocked.createAccountManual.mockResolvedValue({ ...data.people[0]!.accounts[0]!.account, id: "new-acc", provider: "vercel", label: "Vercel" });
    const { onNotify } = await renderMap();
    await screen.findByTestId(`email:${IDS.me}`);

    click(within(shelf()).getByRole("button", { name: /Vercel/ }));

    await waitFor(() => expect(mocked.createAccountManual).toHaveBeenCalledWith(IDS.me, "vercel", "Vercel"));
    expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/Added Vercel under primary@example.com/));
    // The list stays, so the next service is one more click away.
    await waitFor(() => expect(mocked.ledgerOverview).toHaveBeenCalledTimes(2));
    expect(shelf()).toBeInTheDocument();
  });

  it("goes to a service you already have instead of making a second one", async () => {
    serve();
    const { onNotify } = await renderMap();
    await screen.findByTestId(`account:${IDS.github}`);
    const chip = within(shelf()).getByRole("button", { name: /GitHub.*On your map/ });
    click(chip);
    expect(mocked.createAccountManual).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/already have GitHub/));
    expect(screen.getByRole("complementary", { name: "Details" })).toHaveTextContent("GitHub");
  });

  it("offers any typed name as a service of its own", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    await screen.findByTestId(`email:${IDS.me}`);
    await user.type(within(shelf()).getByLabelText("Search services"), "Loopia");
    expect(within(shelf()).getByRole("button", { name: /Add “Loopia”/ })).toBeInTheDocument();
  });

  it("shows what a clicked ball is connected to", async () => {
    serve();
    await renderMap();
    fireEvent.click(await screen.findByTestId(`project:${IDS.project}`));
    const details = screen.getByRole("complementary", { name: "Details" });
    expect(within(details).getByText("Supabase")).toBeInTheDocument();
    expect(within(details).getByText("primary@example.com")).toBeInTheDocument();
    expect(within(details).getByText("DATABASE_URL")).toBeInTheDocument();
  });

  it("copies a key through Rust, never through the page", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    fireEvent.click(await screen.findByTestId(`account:${IDS.github}`));
    await user.click(screen.getByRole("button", { name: "Copy Password" }));
    expect(mocked.copySecret).toHaveBeenCalledWith(IDS.ghPassword);
  });

  it("lets a service be put to use in a project from its menu", async () => {
    serve();
    mocked.createServiceProjectManual.mockResolvedValue({
      id: "res-new",
      account_id: IDS.github,
      organization_id: null,
      provider: "github",
      provider_ref: null,
      name: "blog",
      region: null,
      environment: "unknown",
      url: null,
      notes: null,
      created_at: AT,
    });
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`account:${IDS.github}`));
    const menu = screen.getByRole("menu", { name: /GitHub/ });
    await user.hover(within(menu).getByRole("menuitem", { name: /Use in project/ }));
    await user.click(screen.getByRole("menuitem", { name: "blog" }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith("res-new", IDS.blog));
    expect(mocked.createServiceProjectManual).toHaveBeenCalledWith(IDS.github, null, "github", "blog", null, "unknown");
  });
});

describe("the lock", () => {
  it("takes away everything that changes the map, and gives it back", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    const ball = await screen.findByTestId(`account:${IDS.github}`);

    fireEvent.contextMenu(ball);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: /Editing/ }));
    expect(screen.getByRole("button", { name: /Locked/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(shelf()).getByRole("button", { name: /GitHub/ })).toBeDisabled();

    fireEvent.contextMenu(ball);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Show details" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Delete on the keyboard does nothing either.
    fireEvent.click(ball);
    await user.keyboard("{Delete}");
    expect(mocked.deleteAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Locked/ }));
    fireEvent.contextMenu(ball);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("is remembered", async () => {
    window.localStorage.setItem("devledger.mapLocked", "1");
    serve();
    await renderMap();
    expect(await screen.findByRole("button", { name: /Locked/ })).toBeInTheDocument();
  });

  it("still asks before deleting when unlocked", async () => {
    serve();
    const user = userEvent.setup();
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderMap();
    fireEvent.click(await screen.findByTestId(`account:${IDS.github}`));
    await user.keyboard("{Delete}");
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Delete GitHub and the key stored under it/));
    expect(mocked.deleteAccount).not.toHaveBeenCalled();
  });
});

describe("a project's own page", () => {
  it("shows the project, what it runs on and whose those are, and nothing else", async () => {
    serve();
    await renderMap({ projectId: IDS.project });
    expect(await screen.findByTestId(`project:${IDS.project}`)).toBeInTheDocument();
    expect(screen.getByTestId(`account:${IDS.supabase}`)).toBeInTheDocument();
    expect(screen.getByTestId(`email:${IDS.me}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`account:${IDS.github}`)).toBeNull();
    expect(screen.queryByTestId(`project:${IDS.blog}`)).toBeNull();
  });

  it("picks one of your services for the project from the list", async () => {
    serve();
    mocked.createServiceProjectManual.mockResolvedValue({
      id: "res-gh",
      account_id: IDS.github,
      organization_id: null,
      provider: "github",
      provider_ref: null,
      name: "shop",
      region: null,
      environment: "unknown",
      url: null,
      notes: null,
      created_at: AT,
    });
    await renderMap({ projectId: IDS.project });
    await screen.findByTestId(`project:${IDS.project}`);
    const list = screen.getByRole("complementary", { name: "Add to the map" });
    expect(within(list).getByText("Services for shop")).toBeInTheDocument();
    click(within(list).getByRole("button", { name: /GitHub.*primary@example.com/ }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith("res-gh", IDS.project));
  });

  it("adds a new service for the project and links it straight away", async () => {
    const data = serve();
    mocked.createAccountManual.mockResolvedValue({
      ...data.people[1]!.accounts[0]!.account,
      id: "acc-vercel",
      provider: "vercel",
      label: "Vercel",
    });
    mocked.createServiceProjectManual.mockResolvedValue({
      id: "res-vercel",
      account_id: "acc-vercel",
      organization_id: null,
      provider: "vercel",
      provider_ref: null,
      name: "shop",
      region: null,
      environment: "unknown",
      url: null,
      notes: null,
      created_at: AT,
    });
    await renderMap({ projectId: IDS.project });
    await screen.findByTestId(`project:${IDS.project}`);
    click(within(shelf()).getByRole("button", { name: /Vercel/ }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith("res-vercel", IDS.project));
    expect(mocked.createServiceProjectManual).toHaveBeenCalledWith("acc-vercel", null, "vercel", "shop", null, "unknown");
  });

  it("uses the service you have when it is picked from the full list", async () => {
    serve();
    mocked.createServiceProjectManual.mockResolvedValue({
      id: "res-github",
      account_id: IDS.github,
      organization_id: null,
      provider: "github",
      provider_ref: null,
      name: "shop",
      region: null,
      environment: "unknown",
      url: null,
      notes: null,
      created_at: AT,
    });
    await renderMap({ projectId: IDS.project });
    await screen.findByTestId(`project:${IDS.project}`);
    click(within(shelf()).getByRole("button", { name: /GitHub.*On your map/ }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith("res-github", IDS.project));
    expect(mocked.createAccountManual).not.toHaveBeenCalled();
  });

  it("never moves the saved map from a project's page", async () => {
    serve();
    await renderMap({ projectId: IDS.project });
    await screen.findByTestId(`project:${IDS.project}`);
    expect(mocked.updateCustomField).not.toHaveBeenCalled();
  });
});

describe("inside a service", () => {
  const made = {
    id: "res-new",
    account_id: IDS.supabase,
    organization_id: IDS.org,
    provider: "supabase" as const,
    provider_ref: null,
    name: "make it real",
    region: null,
    environment: "unknown" as const,
    url: null,
    notes: null,
    created_at: AT,
  };

  it("draws an organization and the projects in it", async () => {
    serve();
    await renderMap();
    expect(await screen.findByTestId(`org:${IDS.org}`)).toHaveTextContent("acme's Org");
    expect(screen.getByTestId(`resource:${IDS.resource}`)).toHaveTextContent("shop-db");
  });

  it("adds an organization to a service from its menu", async () => {
    serve();
    mocked.createOrganization.mockResolvedValue({
      id: "org-new",
      account_id: IDS.supabase,
      provider_org_id: null,
      name: "Second Org",
      created_at: AT,
    });
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`account:${IDS.supabase}`));
    await user.hover(screen.getByRole("menuitem", { name: /^Add/ }));
    await user.click(screen.getByRole("menuitem", { name: "Organization…" }));
    const dialog = screen.getByRole("dialog", { name: "Add an organization" });
    await user.type(within(dialog).getByLabelText("Organization name"), "Second Org");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.createOrganization).toHaveBeenCalledWith(IDS.supabase, "Second Org"));
    expect(mocked.addCustomField).toHaveBeenCalledWith({ kind: "organization", id: "org-new" }, "_pos", expect.any(String));
  });

  it("will not add a second organization of the same name to a service", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`account:${IDS.supabase}`));
    await user.hover(screen.getByRole("menuitem", { name: /^Add/ }));
    await user.click(screen.getByRole("menuitem", { name: "Organization…" }));
    const dialog = screen.getByRole("dialog", { name: "Add an organization" });
    await user.type(within(dialog).getByLabelText("Organization name"), "ACME's org");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already has an organization");
    expect(mocked.createOrganization).not.toHaveBeenCalled();
  });

  it("adds a project inside an organization, with its region", async () => {
    serve();
    mocked.createServiceProjectManual.mockResolvedValue(made);
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`org:${IDS.org}`));
    await user.click(screen.getByRole("menuitem", { name: "Add project in acme's Org…" }));
    const dialog = screen.getByRole("dialog", { name: "Add a Supabase project" });
    await user.type(within(dialog).getByLabelText("Project name"), "make it real");
    await user.type(within(dialog).getByLabelText("Region (optional)"), "eu-west-1");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocked.createServiceProjectManual).toHaveBeenCalledWith(
        IDS.supabase,
        IDS.org,
        "supabase",
        "make it real",
        null,
        "unknown",
      ),
    );
    await waitFor(() =>
      expect(mocked.updateResource).toHaveBeenCalledWith("res-new", expect.objectContaining({ region: "eu-west-1" })),
    );
  });

  it("shows an organization's projects as cards, with what uses each", async () => {
    serve();
    await renderMap();
    fireEvent.click(await screen.findByTestId(`org:${IDS.org}`));
    const details = screen.getByRole("complementary", { name: "Details" });
    expect(within(details).getByText("Supabase organization")).toBeInTheDocument();
    expect(within(details).getByRole("heading", { name: "Projects in acme's Org" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: /shop-db.*Used by shop/ })).toBeInTheDocument();
  });

  it("links your project to a project inside a service from its menu", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`resource:${IDS.resource}`));
    await user.hover(screen.getByRole("menuitem", { name: /Use in project/ }));
    await user.click(screen.getByRole("menuitem", { name: "blog" }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith(IDS.resource, IDS.blog));
    expect(mocked.createServiceProjectManual).not.toHaveBeenCalled();
  });

  it("takes a project out of its organization, keeping it under the service", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`resource:${IDS.resource}`));
    await user.hover(screen.getByRole("menuitem", { name: /Move to organization/ }));
    await user.click(screen.getByRole("menuitem", { name: "Out of acme's Org" }));
    await waitFor(() => expect(mocked.assignOrganization).toHaveBeenCalledWith(IDS.resource, null));
    expect(mocked.moveServiceProject).not.toHaveBeenCalled();
  });

  it("renames an organization", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    fireEvent.doubleClick(await screen.findByTestId(`org:${IDS.org}`));
    const input = await screen.findByLabelText("Rename acme's Org");
    await user.clear(input);
    await user.type(input, "Acme{Enter}");
    await waitFor(() => expect(mocked.renameOrganization).toHaveBeenCalledWith(IDS.org, "Acme"));
  });

  it("deletes an organization only after saying its projects stay", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId(`org:${IDS.org}`));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("stay, directly under Supabase"));
    await waitFor(() => expect(mocked.deleteOrganization).toHaveBeenCalledWith(IDS.org));
  });
});

describe("fields", () => {
  it("can be added to every kind of ball", async () => {
    serve();
    const user = userEvent.setup();
    await renderMap();
    const cases: [string, string, EntityRef][] = [
      [`email:${IDS.me}`, "Email", { kind: "identity", id: IDS.me }],
      [`account:${IDS.github}`, "Service", { kind: "account", id: IDS.github }],
      [`org:${IDS.org}`, "Organization", { kind: "organization", id: IDS.org }],
      [`resource:${IDS.resource}`, "Resource", { kind: "service_project", id: IDS.resource }],
      [`project:${IDS.blog}`, "Project", { kind: "project", id: IDS.blog }],
    ];
    for (const [key, name, entity] of cases) {
      fireEvent.click(await screen.findByTestId(key));
      const details = screen.getByRole("complementary", { name: "Details" });
      await user.click(within(details).getByRole("button", { name: "+ Field" }));
      const dialog = screen.getByRole("dialog", { name: "Add field" });
      await user.type(within(dialog).getByLabelText("Field name"), `${name} note`);
      await user.type(within(dialog).getByLabelText("Value"), "x");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mocked.addCustomField).toHaveBeenCalledWith(entity, `${name} note`, "x"));
      fireEvent.click(await screen.findByTestId(key));
    }
  });
});

describe("a project moving onto a project inside a service", () => {
  it("drops the empty line straight to the service it replaces", async () => {
    // "shop" already uses Stripe through the resource drawing that line made.
    const data = canvasVault();
    data.resources.push(resource("r-pay", IDS.stripe, "payments", [], { provider: "stripe" }));
    serve(data);
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId("resource:r-pay"));
    await user.hover(screen.getByRole("menuitem", { name: /Use in project/ }));
    await user.click(screen.getByRole("menuitem", { name: "shop" }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith("r-pay", IDS.project));
    await waitFor(() => expect(mocked.deleteServiceProject).toHaveBeenCalledWith(IDS.stripeShop));
  });

  it("keeps it when keys are stored on it", async () => {
    const data = canvasVault();
    const made = data.resources[1];
    if (made) made.secret_count = 1;
    data.resources.push(resource("r-pay", IDS.stripe, "payments", [], { provider: "stripe" }));
    serve(data);
    const user = userEvent.setup();
    await renderMap();
    fireEvent.contextMenu(await screen.findByTestId("resource:r-pay"));
    await user.hover(screen.getByRole("menuitem", { name: /Use in project/ }));
    await user.click(screen.getByRole("menuitem", { name: "shop" }));
    await waitFor(() => expect(mocked.linkServiceProject).toHaveBeenCalledWith("r-pay", IDS.project));
    expect(mocked.deleteServiceProject).not.toHaveBeenCalled();
  });
});
