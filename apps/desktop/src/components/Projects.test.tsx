import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { ProjectSummary } from "../lib/types";
import Projects, { recentProjects } from "./Projects";

vi.mock("../lib/api");
// The tree has its own tests; here it only needs to be told which project.
vi.mock("./LedgerCanvas", () => ({
  default: ({ projectId }: { projectId?: string | null }) => <div data-testid="tree">tree:{projectId}</div>,
}));

const mocked = vi.mocked(api);

function summary(id: string, name: string, created: string, secrets = 0): ProjectSummary {
  return {
    project: { id, name, description: null, created_at: created },
    service_project_count: 1,
    secret_count: secrets,
    providers: ["supabase", "vercel"],
  };
}

const PROJECTS = [
  summary("p1", "deploydoctor", "2026-09-01T10:00:00Z", 4),
  summary("p2", "nyttolabs", "2026-09-10T10:00:00Z"),
  summary("p3", "curl-to-buy2.0", "2026-09-20T10:00:00Z"),
];

function renderPage(openId: string | null = null) {
  const props = {
    projects: PROJECTS,
    openId,
    onOpen: vi.fn(),
    onNotify: vi.fn(),
    onChanged: vi.fn(),
    refreshKey: 0,
    onPaste: vi.fn(),
    analyzing: false,
    onAdd: vi.fn(),
  };
  render(<Projects {...props} />);
  return props;
}

beforeEach(() => {
  vi.resetAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has storage; the page copes when a browser does not.
  }
});

describe("Projects page", () => {
  it("lists every project as a card", () => {
    renderPage();
    const list = screen.getByRole("region", { name: "Projects" });
    for (const name of ["deploydoctor", "nyttolabs", "curl-to-buy2.0"]) {
      expect(within(list).getByText(name)).toBeInTheDocument();
    }
    expect(within(list).getByText("1 resource · 4 secrets")).toBeInTheDocument();
  });

  it("narrows the list with Find Project and opens the first hit on Enter", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.type(screen.getByLabelText("Find Project"), "nytto");
    const list = screen.getByRole("region", { name: "Projects" });
    expect(within(list).queryByText("deploydoctor")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenCalledWith("p2");
  });

  it("switches project from the All Projects dropdown", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(screen.getByRole("button", { name: /All Projects/ }));
    await user.click(within(screen.getByRole("menu", { name: "All Projects" })).getByRole("menuitem", { name: "curl-to-buy2.0" }));
    expect(props.onOpen).toHaveBeenCalledWith("p3");
  });

  it("creates a project with any name and opens it", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    mocked.createProject.mockResolvedValue({ id: "p9", name: "Mitt Nya Projekt!", description: null, created_at: "" });
    await user.click(screen.getByRole("button", { name: /Add New/ }));
    await user.click(screen.getByRole("menuitem", { name: "Project" }));
    const dialog = screen.getByRole("dialog", { name: "Create Project" });
    await user.type(within(dialog).getByLabelText("Project name"), "Mitt Nya Projekt!");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocked.createProject).toHaveBeenCalledWith("Mitt Nya Projekt!", null));
    expect(props.onOpen).toHaveBeenCalledWith("p9");
  });

  it("offers the other Add New kinds through the add dialog", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(screen.getByRole("button", { name: /Add New/ }));
    await user.click(screen.getByRole("menuitem", { name: "API key" }));
    expect(props.onAdd).toHaveBeenCalledWith("api_key");
  });

  it("shows the five most recently opened projects first, then the newest", () => {
    const many = [
      ...PROJECTS,
      summary("p4", "four", "2026-09-21T10:00:00Z"),
      summary("p5", "five", "2026-09-22T10:00:00Z"),
      summary("p6", "six", "2026-09-23T10:00:00Z"),
    ];
    const recent = recentProjects(many, ["p1", "gone"]).map((p) => p.project.id);
    expect(recent).toEqual(["p1", "p6", "p5", "p4", "p3"]);
  });
});

describe("Inside a project", () => {
  it("shows the project's slice of the skill tree", async () => {
    renderPage("p1");
    expect(screen.getByRole("heading", { name: "deploydoctor" })).toBeInTheDocument();
    expect(await screen.findByTestId("tree")).toHaveTextContent("tree:p1");
  });

  it("says what a paste looks like, then files it into this project", async () => {
    const user = userEvent.setup();
    const props = renderPage("p1");
    const box = screen.getByLabelText("Paste into deploydoctor");
    await user.click(box);
    await user.paste("RESEND_API_KEY=re_exampleNotReal123\nSTRIPE_KEY=sk_test_exampleNotReal");
    expect(screen.getByText("2 × .env variables")).toBeInTheDocument();
    expect(screen.getByText("Resend API key")).toBeInTheDocument();
    expect(screen.getByText("Stripe secret key")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add to deploydoctor" }));
    expect(props.onPaste).toHaveBeenCalledWith(
      "RESEND_API_KEY=re_exampleNotReal123\nSTRIPE_KEY=sk_test_exampleNotReal",
      "p1",
    );
    // The text is handed over, not kept on screen.
    expect(box).toHaveValue("");
  });

  it("goes back to All Projects from the breadcrumb", async () => {
    const user = userEvent.setup();
    const props = renderPage("p2");
    await user.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "All Projects" }));
    expect(props.onOpen).toHaveBeenCalledWith(null);
  });

  it("keeps the variables table one tab away", async () => {
    const user = userEvent.setup();
    mocked.listSecrets.mockResolvedValue([]);
    mocked.serviceProjectsForProject.mockResolvedValue([]);
    mocked.projectEnvironments.mockResolvedValue([]);
    mocked.envConflicts.mockResolvedValue([]);
    renderPage("p1");
    await user.click(screen.getByRole("tab", { name: "Variables" }));
    await waitFor(() => expect(mocked.listSecrets).toHaveBeenCalledWith("p1"));
  });
});
