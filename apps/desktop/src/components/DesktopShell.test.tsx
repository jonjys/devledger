import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import DesktopShell from "./DesktopShell";

vi.mock("../lib/api");
vi.mock("./SkillTree", () => ({ default: () => <div data-testid="tree" /> }));

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
