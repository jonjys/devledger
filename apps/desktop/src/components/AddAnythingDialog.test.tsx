import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { Account, IdentityNode, ProjectSummary } from "../lib/types";
import AddAnythingDialog from "./AddAnythingDialog";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";

const account: Account = {
  id: "acc-1",
  identity_id: "person-1",
  provider: "other:Loopia",
  external_ref: null,
  label: "Domains",
  login_email: null,
  username: null,
  url: "https://customerzone.loopia.se",
  notes: null,
  created_at: AT,
};

const graph: IdentityNode[] = [
  {
    identity: { id: "person-1", label: "Me", email: "me@example.com", email_blind_index: "bi", created_at: AT },
    accounts: [{ account, organizations: [], unassigned: [], subscriptions: [] }],
  },
];

const projects: ProjectSummary[] = [
  {
    project: { id: "project-1", name: "Storefront", description: null, created_at: AT },
    service_project_count: 0,
    secret_count: 0,
    providers: [],
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocked.identityGraph.mockResolvedValue(graph);
  mocked.listProjects.mockResolvedValue(projects);
});

function open() {
  const onDone = vi.fn();
  const onNotify = vi.fn();
  const onClose = vi.fn();
  render(<AddAnythingDialog onClose={onClose} onDone={onDone} onNotify={onNotify} />);
  return { onDone, onNotify, onClose };
}

async function choose(user: ReturnType<typeof userEvent.setup>, kind: string) {
  await user.click(await screen.findByRole("radio", { name: kind }));
}

describe("Add anything", () => {
  it("turns a typed word into a project", async () => {
    const user = userEvent.setup();
    mocked.createProject.mockResolvedValue(projects[0]!.project);
    const { onDone } = open();

    await user.type(screen.getByLabelText("Text"), "Storefront");
    await choose(user, "Project");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mocked.createProject).toHaveBeenCalledWith("Storefront", null));
    expect(onDone).toHaveBeenCalled();
  });

  it("turns an address into a person", async () => {
    const user = userEvent.setup();
    mocked.createIdentityManual.mockResolvedValue(graph[0]!.identity);
    open();

    await choose(user, "Email / person");
    await user.type(screen.getByLabelText("Text"), "work@example.com");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocked.createIdentityManual).toHaveBeenCalledWith("", "work@example.com"),
    );
  });

  it("records any service by name for the chosen person", async () => {
    const user = userEvent.setup();
    mocked.createAccountManual.mockResolvedValue(account);
    open();

    await choose(user, "Service account");
    await user.type(screen.getByLabelText("Text"), "Loopia");
    expect(screen.getByText(/your own service, "Loopia"/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocked.createAccountManual).toHaveBeenCalledWith("person-1", "other:Loopia", "Loopia"),
    );
  });

  it("sets a username on an existing account without disturbing its other details", async () => {
    const user = userEvent.setup();
    mocked.updateAccount.mockResolvedValue(undefined);
    open();

    await choose(user, "Username");
    await user.type(screen.getByLabelText("Text"), "acme_dev");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocked.updateAccount).toHaveBeenCalledWith("acc-1", "Domains", {
        login_email: null,
        username: "acme_dev",
        url: "https://customerzone.loopia.se",
        notes: null,
      }),
    );
  });

  it("types a password masked and seals it on the account", async () => {
    const user = userEvent.setup();
    mocked.storeSecret.mockResolvedValue({} as never);
    open();

    await choose(user, "Password");
    const input = screen.getByLabelText("Text");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "correct horse");
    await user.click(screen.getByRole("button", { name: "Store encrypted" }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        {
          owner: { project_id: null, service_project_id: null, account_id: "acc-1" },
          kind: "password",
          name: "Password",
          environment: "unknown",
          notes: null,
        },
        "correct horse",
      ),
    );
  });

  it("files an env variable under a project and environment", async () => {
    const user = userEvent.setup();
    mocked.storeSecret.mockResolvedValue({} as never);
    open();

    await choose(user, "Env variable");
    await user.type(screen.getByLabelText("Name"), "DATABASE_URL");
    await user.type(screen.getByLabelText("Text"), "postgres://localhost/dev");
    await user.selectOptions(screen.getByLabelText("Environment"), "production");
    await user.click(screen.getByRole("button", { name: "Store encrypted" }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        {
          owner: { project_id: "project-1", service_project_id: null, account_id: null },
          kind: "env_var",
          name: "DATABASE_URL",
          environment: "production",
          notes: null,
        },
        "postgres://localhost/dev",
      ),
    );
  });

  it("adds an own field, with a name the user chose, to whatever they pick", async () => {
    const user = userEvent.setup();
    mocked.addCustomField.mockResolvedValue({} as never);
    open();

    await choose(user, "Own field");
    await user.type(screen.getByLabelText("Name"), "Customer number");
    await user.type(screen.getByLabelText("Text"), "LP-448812");
    await user.selectOptions(screen.getByLabelText("Belongs to"), "account:acc-1");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocked.addCustomField).toHaveBeenCalledWith(
        { kind: "account", id: "acc-1" },
        "Customer number",
        "LP-448812",
      ),
    );
  });

  it("says what is missing instead of failing when there is nothing to attach to", async () => {
    const user = userEvent.setup();
    mocked.identityGraph.mockResolvedValue([]);
    mocked.listProjects.mockResolvedValue([]);
    open();

    await choose(user, "Username");
    await user.type(screen.getByLabelText("Text"), "acme_dev");
    expect(await screen.findByText("Add a service account first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });
});
