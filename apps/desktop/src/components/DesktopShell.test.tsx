import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import DesktopShell from "./DesktopShell";

vi.mock("../lib/api");
vi.mock("./LedgerCanvas", () => ({ default: () => <div data-testid="tree" /> }));

const mocked = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
  mocked.listProjects.mockResolvedValue([
    {
      project: { id: "p1", name: "acme-shop", description: null, created_at: "2026-09-01T10:00:00Z" },
      service_project_count: 0,
      secret_count: 0,
      providers: [],
    },
  ]);
  mocked.needsAttention.mockResolvedValue([]);
  mocked.listSubscriptions.mockResolvedValue([]);
  mocked.listSecrets.mockResolvedValue([]);
  mocked.serviceProjectsForProject.mockResolvedValue([]);
  mocked.projectEnvironments.mockResolvedValue([]);
  mocked.envConflicts.mockResolvedValue([]);
});

describe("the sidebar", () => {
  it("takes Projects back to the list from inside a project", async () => {
    const user = userEvent.setup();
    render(<DesktopShell onLock={vi.fn()} />);

    const list = await screen.findByRole("region", { name: "Projects" });
    await user.click(await within(list).findByRole("button", { name: /acme-shop/ }));
    expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Find Project")).toBeInTheDocument();
  });
});

describe("the layout", () => {
  it("opens on the saved start page and shows only the saved tabs, in order", async () => {
    mocked.uiLayoutGet.mockResolvedValue({
      layout: JSON.stringify({ v: 1, boxes: [{ id: "n", kind: "note", title: "Today", text: "ship it" }], tabs: ["home", "secrets", "projects"], start: "home", templates: [] }),
    });
    mocked.identityGraph.mockResolvedValue([]);
    render(<DesktopShell onLock={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Today" })).toHaveTextContent("ship it");
    const menu = screen.getByRole("navigation", { name: "Menu" });
    const tabs = within(menu)
      .getAllByRole("button")
      .map((b) => b.textContent?.trim())
      .filter((t) => t !== "⋯More");
    expect(tabs).toEqual(["Home", "Secrets", "Projects"]);
    expect(within(menu).queryByRole("button", { name: "Ledger" })).toBeNull();
  });

  it("saves a change to the layout, and flushes it before locking", async () => {
    const user = userEvent.setup();
    const onLock = vi.fn();
    mocked.uiLayoutGet.mockResolvedValue({
      layout: JSON.stringify({ v: 1, boxes: [], tabs: ["home", "projects"], start: "home", templates: [] }),
    });
    mocked.uiLayoutSet.mockResolvedValue(undefined);
    mocked.identityGraph.mockResolvedValue([]);
    render(<DesktopShell onLock={onLock} />);

    await user.click(await screen.findByRole("button", { name: "Edit layout" }));
    await user.click(screen.getByRole("button", { name: "+ Add a box" }));
    await user.click(screen.getByRole("button", { name: /^Note/ }));
    await user.click(screen.getByRole("button", { name: "Lock vault" }));

    expect(mocked.uiLayoutSet).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(mocked.uiLayoutSet.mock.calls[0]![0]);
    expect(saved.boxes.map((b: { kind: string }) => b.kind)).toEqual(["note"]);
    expect(onLock).toHaveBeenCalled();
  });
});
