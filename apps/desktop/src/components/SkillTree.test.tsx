import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import { STATE_FIELD, serializeState, shortId } from "../lib/skillTree";
import type { Account, CustomField, EntityRef, ProjectSummary } from "../lib/types";
import { AT, IDS, accountNode, vault } from "../test/tree-fixtures";
import SkillTree from "./SkillTree";

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
      this.cb(
        [{ target, contentRect } as unknown as ResizeObserverEntry],
        this as unknown as globalThis.ResizeObserver,
      );
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
    offsetHeight: { configurable: true, get() { return 40; } },
    offsetWidth: { configurable: true, get() { return 160; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
});

const STATE = serializeState({
  categories: [{ id: "k1", name: "Code", accounts: [shortId(IDS.github)] }],
  statuses: {},
});

function projectSummary(id: string, name: string): ProjectSummary {
  return {
    project: { id, name, description: null, created_at: AT },
    service_project_count: 0,
    secret_count: 0,
    providers: [],
  };
}

function account(id: string, provider: Account["provider"], label: string): Account {
  return accountNode(id, IDS.me, provider, label).account;
}

/** Serve the fixture vault through the mocked API. */
function serve(data = vault(STATE)) {
  mocked.ledgerOverview.mockImplementation(async () => data.people);
  mocked.listAllSecrets.mockResolvedValue(data.secrets);
  mocked.needsAttention.mockResolvedValue(data.attention);
  mocked.listServiceProjects.mockResolvedValue(data.resources);
  mocked.listProjects.mockResolvedValue(data.projects.map((p) => projectSummary(p.id, p.name)));
  mocked.customFields.mockImplementation(async (entity: EntityRef): Promise<CustomField[]> =>
    entity.kind === "identity"
      ? (data.identityFields.get(entity.id) ?? [])
      : (data.accountFields.get(entity.id) ?? []),
  );
  return data;
}

async function renderTree() {
  const onNotify = vi.fn();
  render(<SkillTree onNotify={onNotify} onChanged={vi.fn()} />);
  await screen.findByTestId("primary");
  return { onNotify };
}

function node(key: string): HTMLElement {
  return screen.getByTestId(key);
}

async function menuPick(path: string[]) {
  const user = userEvent.setup();
  for (const label of path) {
    const items = screen.getAllByRole("menuitem", { name: new RegExp(`^${label}`) });
    const last = items[items.length - 1];
    if (!last) throw new Error(`no menu item ${label}`);
    await user.click(last);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Skill tree", () => {
  it("puts the primary identity's email at the centre", async () => {
    serve();
    await renderTree();
    expect(within(node("primary")).getByText("primary@example.com")).toBeInTheDocument();
    expect(within(node("primary")).getByText("PRIMARY")).toBeInTheDocument();
    expect(within(node("category:k1")).getByText("Code")).toBeInTheDocument();
  });

  it("adds a category from the right-click menu and saves it in the hidden field", async () => {
    serve();
    const user = userEvent.setup();
    await renderTree();

    fireEvent.contextMenu(node("primary"));
    await menuPick(["Add", "Category"]);
    const dialog = screen.getByRole("dialog", { name: "Add category" });
    await user.type(within(dialog).getByLabelText("Category name"), "AI");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocked.updateCustomField).toHaveBeenCalled());
    const [fieldId, label, value] = mocked.updateCustomField.mock.calls[0] ?? [];
    expect(fieldId).toBe(IDS.stateField);
    expect(label).toBe(STATE_FIELD);
    expect(JSON.parse(value as string).c.map((c: { n: string }) => c.n)).toEqual(["Code", "AI"]);
  });

  it("adds Resend under the primary, then stores its API key in the vault", async () => {
    const data = serve();
    const user = userEvent.setup();
    await renderTree();

    const resend = account("ac0000aa-0000-4000-8000-000000000000", "other:Resend", "Resend");
    mocked.createAccountManual.mockImplementation(async () => {
      data.people[0]?.accounts.push(accountNode(resend.id, IDS.me, "other:Resend", "Resend"));
      return resend;
    });

    fireEvent.contextMenu(node("primary"));
    await menuPick(["Add", "Account"]);
    let dialog = screen.getByRole("dialog", { name: "Add account" });
    await user.type(within(dialog).getByLabelText("Service"), "resend");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.createAccountManual).toHaveBeenCalledWith(IDS.me, "other:Resend", "Resend"),
    );
    const resendNode = await screen.findByTestId(`account:${resend.id}`);
    // Regression: adding used to replace the lit set without the centre, and
    // the whole tree collapsed to the primary alone.
    expect(node("category:k1")).toBeInTheDocument();
    expect(node(`identity:${IDS.other}`)).toBeInTheDocument();

    mocked.storeSecret.mockResolvedValue({
      id: "5e0000aa-0000-4000-8000-000000000000",
      project_id: null,
      service_project_id: null,
      account_id: resend.id,
      kind: "generic_api_key",
      name: "API key",
      preview: "re_•••ple",
      value_blind_index: "bi",
      environment: "unknown",
      notes: null,
      created_at: AT,
      updated_at: AT,
    });
    fireEvent.contextMenu(resendNode);
    await menuPick(["Add", "API key"]);
    dialog = screen.getByRole("dialog", { name: "Add API key" });
    const value = within(dialog).getByLabelText("Value");
    expect(value).toHaveAttribute("type", "password");
    await user.type(value, "re_example_not_real");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        {
          owner: { project_id: null, service_project_id: null, account_id: resend.id },
          kind: "generic_api_key",
          name: "API key",
          environment: "unknown",
          notes: null,
        },
        "re_example_not_real",
      ),
    );
  });

  it("files a new account straight into the category it was added under", async () => {
    const data = serve();
    const user = userEvent.setup();
    await renderTree();
    const claude = account("ac0000bb-0000-4000-8000-000000000000", "anthropic", "Claude");
    mocked.createAccountManual.mockImplementation(async () => {
      data.people[0]?.accounts.push(accountNode(claude.id, IDS.me, "anthropic", "Claude"));
      return claude;
    });

    fireEvent.contextMenu(node("category:k1"));
    await menuPick(["Add", "Account"]);
    const dialog = screen.getByRole("dialog", { name: "Add account" });
    await user.type(within(dialog).getByLabelText("Service"), "Claude");
    await user.type(within(dialog).getByLabelText("Label (optional)"), "Claude");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocked.createAccountManual).toHaveBeenCalledWith(IDS.me, "anthropic", "Claude"));
    await waitFor(() => expect(mocked.updateCustomField).toHaveBeenCalled());
    const saved = JSON.parse(mocked.updateCustomField.mock.calls[0]?.[2] as string);
    expect(saved.c[0].a).toContain(shortId(claude.id));
  });

  it("copies a secret through Rust and says so, showing only the mask", async () => {
    serve();
    const { onNotify } = await renderTree();
    fireEvent.click(node(`account:${IDS.github}`)); // light the account: its fields appear
    const password = await screen.findByTestId(`secret:${IDS.ghPassword}`);
    expect(within(password).getByText("ex•••le")).toBeInTheDocument();

    fireEvent.contextMenu(password);
    await menuPick(["Copy"]);
    await waitFor(() => expect(mocked.copySecret).toHaveBeenCalledWith(IDS.ghPassword));
    expect(mocked.revealSecret).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("clipboard clears in 30 seconds"));
  });

  it("renames a category in place on double-click", async () => {
    serve();
    const user = userEvent.setup();
    await renderTree();
    fireEvent.doubleClick(node("category:k1"));
    const input = await screen.findByLabelText("Rename Code");
    // Typing must go straight into the field, without clicking it first.
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "Code & CI{Enter}");
    await waitFor(() => expect(mocked.updateCustomField).toHaveBeenCalled());
    expect(JSON.parse(mocked.updateCustomField.mock.calls[0]?.[2] as string).c[0].n).toBe("Code & CI");
  });

  it("lights and opens an account on click, and puts it out on a second click", async () => {
    serve();
    await renderTree();
    const github = node(`account:${IDS.github}`);
    expect(screen.queryByTestId(`secret:${IDS.ghPassword}`)).not.toBeInTheDocument();
    fireEvent.click(github);
    expect(await screen.findByTestId(`secret:${IDS.ghPassword}`)).toBeInTheDocument();
    expect(node(`account:${IDS.github}`)).toHaveClass("lit");
    fireEvent.click(node(`account:${IDS.github}`));
    await waitFor(() => expect(screen.queryByTestId(`secret:${IDS.ghPassword}`)).not.toBeInTheDocument());
  });

  it("finds a project with Cmd+K and filters the tree to it", async () => {
    serve();
    const user = userEvent.setup();
    await renderTree();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    const search = await screen.findByLabelText("Find project, account or field");
    await user.type(search, "shop{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "shop" })).toHaveClass("active"));
    expect(screen.queryByTestId(`account:${IDS.github}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`account:${IDS.supabase}`)).toBeInTheDocument();
  });

  it("moves the primary: the field goes to the new identity and leaves the old one", async () => {
    serve();
    await renderTree();
    fireEvent.contextMenu(node(`identity:${IDS.other}`));
    await menuPick(["Make Primary"]);
    await waitFor(() =>
      expect(mocked.addCustomField).toHaveBeenCalledWith({ kind: "identity", id: IDS.other }, STATE_FIELD, STATE),
    );
    await waitFor(() => expect(mocked.deleteCustomField).toHaveBeenCalledWith(IDS.stateField));
  });

  it("offers to add an email when the vault is empty", async () => {
    const data = vault(null);
    data.people = [];
    serve(data);
    render(<SkillTree onNotify={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Add your email" })).toBeInTheDocument();
  });
});
