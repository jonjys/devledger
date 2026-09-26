import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { Environment, ProjectSummary, VaultEntry } from "../lib/types";
import ProjectVault from "./ProjectVault";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";

const summary: ProjectSummary = {
  project: { id: "project-1", name: "Storefront", description: null, created_at: AT },
  service_project_count: 2,
  secret_count: 2,
  providers: ["supabase"],
};

function entry(id: string, name: string, environment: Environment, source: string | null): VaultEntry {
  return {
    secret: {
      id,
      project_id: source ? null : "project-1",
      service_project_id: source ? `sp-${id}` : null,
      account_id: null,
      kind: "postgres_connection_string",
      name,
      preview: "post•••app",
      value_blind_index: `bi-${id}`,
      environment,
      notes: null,
      created_at: AT,
      updated_at: AT,
    },
    client_unsafe: true,
    provider: "supabase",
    service_project_name: source,
  };
}

const confirmSpy = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  confirmSpy.mockReset().mockReturnValue(true);
  vi.spyOn(window, "confirm").mockImplementation(confirmSpy);
  mocked.serviceProjectsForProject.mockResolvedValue([]);
  mocked.envConflicts.mockResolvedValue([]);
});

function renderVault() {
  const onNotify = vi.fn();
  const onChanged = vi.fn();
  render(<ProjectVault summary={summary} onNotify={onNotify} onChanged={onChanged} />);
  return { onNotify, onChanged };
}

describe("Project Vault", () => {
  it("shows which environment each variable belongs to", async () => {
    mocked.listSecrets.mockResolvedValue([
      entry("a", "DATABASE_URL", "development", "db-dev"),
      entry("b", "DATABASE_URL", "production", "db-prod"),
    ]);
    renderVault();

    const [, first, second] = await screen.findAllByRole("row");
    expect(within(first!).getByText("Development")).toBeInTheDocument();
    expect(within(second!).getByText("Production")).toBeInTheDocument();
  });

  it("blocks Copy .env and explains why when names clash across environments", async () => {
    mocked.listSecrets.mockResolvedValue([
      entry("a", "DATABASE_URL", "development", "db-dev"),
      entry("b", "DATABASE_URL", "production", "db-prod"),
    ]);
    mocked.envConflicts.mockResolvedValue([
      {
        name: "DATABASE_URL",
        definitions: [
          { secret_id: "a", environment: "development", source: "db-dev" },
          { secret_id: "b", environment: "production", source: "db-prod" },
        ],
      },
    ]);
    renderVault();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("DATABASE_URL")).toBeInTheDocument();
    expect(alert).toHaveTextContent("Development via db-dev");
    expect(alert).toHaveTextContent("Production via db-prod");
    expect(screen.getByRole("button", { name: "Copy .env" })).toBeDisabled();
    expect(mocked.copyEnv).not.toHaveBeenCalled();
  });

  it("re-checks for clashes when a single environment is chosen", async () => {
    const user = userEvent.setup();
    mocked.listSecrets.mockResolvedValue([entry("a", "DATABASE_URL", "development", null)]);
    renderVault();

    await screen.findByText("DATABASE_URL");
    await user.selectOptions(screen.getByLabelText("Environment to export"), "production");

    await waitFor(() =>
      expect(mocked.envConflicts).toHaveBeenLastCalledWith("project-1", "production"),
    );
  });

  it("asks before deleting a secret, because the value cannot be recovered", async () => {
    const user = userEvent.setup();
    mocked.listSecrets.mockResolvedValue([entry("a", "DATABASE_URL", "production", null)]);
    confirmSpy.mockReturnValue(false);
    renderVault();

    await screen.findByText("DATABASE_URL");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("cannot be recovered"));
    expect(mocked.deleteSecret).not.toHaveBeenCalled();
  });

  it("says how many secrets a project delete would destroy", async () => {
    const user = userEvent.setup();
    mocked.listSecrets.mockResolvedValue([entry("a", "DATABASE_URL", "production", null)]);
    mocked.projectDeletionImpact.mockResolvedValue({ secrets_deleted: 3, resources_unlinked: 2 });
    confirmSpy.mockReturnValue(false);
    renderVault();

    await screen.findByText("DATABASE_URL");
    await user.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const prompt = String(confirmSpy.mock.calls[0]?.[0]);
    expect(prompt).toContain("3 secrets");
    expect(prompt).toContain("cannot be recovered");
    expect(prompt).toContain("2 linked resources");
    expect(mocked.deleteProject).not.toHaveBeenCalled();
  });

  it("adds a variable for a chosen environment, sealed in Rust", async () => {
    const user = userEvent.setup();
    mocked.listSecrets.mockResolvedValue([]);
    mocked.storeSecret.mockResolvedValue(entry("n", "API_URL", "staging", null).secret);
    renderVault();

    await user.click(await screen.findByRole("button", { name: "+ Variable" }));
    const form = screen.getByRole("form", { name: "New variable" });
    await user.type(within(form).getByLabelText("Variable name"), "API_URL");
    const value = within(form).getByLabelText("Variable value");
    expect(value).toHaveAttribute("type", "password");
    await user.type(value, "https://staging.example.com");
    await user.selectOptions(within(form).getByLabelText("Variable environment"), "staging");
    await user.click(within(form).getByRole("button", { name: "Store encrypted" }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        {
          owner: { project_id: "project-1", service_project_id: null, account_id: null },
          kind: "env_var",
          name: "API_URL",
          environment: "staging",
          notes: null,
        },
        "https://staging.example.com",
      ),
    );
  });
});
