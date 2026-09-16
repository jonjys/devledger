import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import { reportFixture, supabaseConnector } from "../test/connect-fixtures";
import type { ConnectionSummary } from "../lib/types";
import ConnectionsView from "./ConnectionsView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);

function connection(label: string, id = "conn-1"): ConnectionSummary {
  return {
    connection: {
      id,
      connector_id: "supabase",
      identity_id: "identity-1",
      account_id: "account-1",
      label,
      account_fingerprint: "fp",
      created_at: "2026-09-16T10:00:00Z",
      last_checked_at: "2026-09-16T12:00:00Z",
    },
    identity_email: label,
    organization_count: 2,
    resource_count: 5,
  };
}

function renderView(connections: ConnectionSummary[] = []) {
  mocked.listConnectors.mockResolvedValue([supabaseConnector()]);
  mocked.listConnections.mockResolvedValue(connections);
  const onNotify = vi.fn();
  const onChanged = vi.fn();
  render(<ConnectionsView onNotify={onNotify} onChanged={onChanged} />);
  return { onNotify, onChanged };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Connections screen", () => {
  it("offers Connect when nothing is connected yet", async () => {
    renderView();
    expect(await screen.findByText("Supabase")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.getByText("No accounts connected yet.")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });

  it("lists each connected account separately with its own counts", async () => {
    renderView([connection("a@example.com", "c1"), connection("b@example.com", "c2")]);

    expect(await screen.findByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("b@example.com")).toBeInTheDocument();

    // Each gets its own actions, so one account can be refreshed or
    // disconnected without touching the other.
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(2);
  });

  it("invites another account rather than replacing the first", async () => {
    renderView([connection("a@example.com")]);
    expect(
      await screen.findByRole("button", { name: "+ Connect another account" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });
});

describe("Connect dialog", () => {
  it("asks for a token, not a password, and says where to get one", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    expect(
      screen.getByText("https://supabase.com/dashboard/account/tokens"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Never paste your Supabase password/)).toBeInTheDocument();
    expect(screen.getByText("api.supabase.com")).toBeInTheDocument();

    // The token field is masked.
    expect(screen.getByLabelText("Access token")).toHaveAttribute("type", "password");
  });

  it("requires both a label and a token before connecting", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: "Connect" }));

    // Scoped to the dialog: the card behind it also has a Connect button.
    const dialog = screen.getByRole("dialog", { name: "Connect" });
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();

    await user.type(screen.getByLabelText("Label this account"), "a@example.com");
    expect(connect).toBeDisabled();

    await user.type(screen.getByLabelText("Access token"), "sbp_token");
    expect(connect).toBeEnabled();
  });

  it("sends the token to the backend and opens the review", async () => {
    const user = userEvent.setup();
    const report = reportFixture();
    mocked.connectorConnect.mockResolvedValue({
      connection: connection("a@example.com").connection,
      reconnected: false,
      report,
    });
    renderView();

    await user.click(await screen.findByRole("button", { name: "Connect" }));
    await user.type(screen.getByLabelText("Label this account"), "a@example.com");
    await user.type(screen.getByLabelText("Access token"), "sbp_token");
    await user.click(
      within(screen.getByRole("dialog", { name: "Connect" })).getByRole("button", {
        name: "Connect",
      }),
    );

    await waitFor(() =>
      expect(mocked.connectorConnect).toHaveBeenCalledWith(
        "supabase",
        "sbp_token",
        "a@example.com",
      ),
    );
    expect(await screen.findByText("Review import")).toBeInTheDocument();
  });

  it("shows the backend's error and stays open so the token can be corrected", async () => {
    const user = userEvent.setup();
    mocked.connectorConnect.mockRejectedValue(
      new Error("the provider rejected this token."),
    );
    renderView();

    await user.click(await screen.findByRole("button", { name: "Connect" }));
    await user.type(screen.getByLabelText("Label this account"), "a@example.com");
    await user.type(screen.getByLabelText("Access token"), "sbp_wrong");
    await user.click(
      within(screen.getByRole("dialog", { name: "Connect" })).getByRole("button", {
        name: "Connect",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "the provider rejected this token.",
    );
    expect(screen.getByLabelText("Access token")).toBeInTheDocument();
  });
});

describe("Import review", () => {
  async function openReview() {
    const user = userEvent.setup();
    mocked.connectorReport.mockResolvedValue(reportFixture());
    const handles = renderView([connection("a@example.com")]);
    await user.click(await screen.findByRole("button", { name: "Review import" }));
    await screen.findByRole("dialog", { name: "Review import" });
    return { user, ...handles };
  }

  it("groups discovered projects under their organization", async () => {
    await openReview();
    const dialog = screen.getByRole("dialog", { name: "Review import" });
    expect(within(dialog).getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("heading", { name: "Projects with no visible organization" }),
    ).toBeInTheDocument();
  });

  it("labels every row with its status", async () => {
    await openReview();
    expect(screen.getAllByText("Unmatched")).toHaveLength(2);
    expect(screen.getByText("Matched")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Conflict")).toBeInTheDocument();
    expect(screen.getByText("Possible match")).toBeInTheDocument();
  });

  it("warns about conflicts and refuses to let them be ticked", async () => {
    await openReview();
    expect(screen.getByText(/1 conflict cannot be imported/)).toBeInTheDocument();

    const row = screen.getByText("Shared").closest(".import-row") as HTMLElement;
    const checkbox = within(row).getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
  });

  it("does not pre-tick a possible match", async () => {
    await openReview();
    const row = screen.getByText("Orphan").closest(".import-row") as HTMLElement;
    const checkbox = within(row).getByRole("checkbox");
    expect(checkbox).toBeEnabled();
    expect(checkbox).not.toBeChecked();
  });

  it("imports only the ticked rows", async () => {
    const { user } = await openReview();
    mocked.connectorImport.mockResolvedValue({
      organizations_created: 1,
      organizations_updated: 0,
      resources_created: 1,
      resources_updated: 1,
      skipped: 0,
      conflicts_refused: 0,
    });

    await user.click(screen.getByRole("button", { name: "Import 3" }));

    await waitFor(() => expect(mocked.connectorImport).toHaveBeenCalled());
    const [connectionId, accepted] = mocked.connectorImport.mock.calls[0]!;
    expect(connectionId).toBe("44444444-4444-4444-8444-444444444444");
    expect([...accepted].sort()).toEqual([
      "aaaaaaaaaaaaaaaaaaaa",
      "cccccccccccccccccccc",
      "org_a",
    ]);
    expect(accepted).not.toContain("dddddddddddddddddddd");
  });

  it("lets a possible match be opted into", async () => {
    const { user } = await openReview();
    mocked.connectorImport.mockResolvedValue({
      organizations_created: 0,
      organizations_updated: 0,
      resources_created: 0,
      resources_updated: 1,
      skipped: 0,
      conflicts_refused: 0,
    });

    const row = screen.getByText("Orphan").closest(".import-row") as HTMLElement;
    await user.click(within(row).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Import 4" }));

    await waitFor(() => expect(mocked.connectorImport).toHaveBeenCalled());
    expect(mocked.connectorImport.mock.calls[0]![1]).toContain("eeeeeeeeeeeeeeeeeeee");
  });

  it("cancels without importing", async () => {
    const { user } = await openReview();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocked.connectorImport).not.toHaveBeenCalled();
  });
});

describe("disconnecting", () => {
  it("removes the connection and says the data is kept", async () => {
    const user = userEvent.setup();
    mocked.connectorDisconnect.mockResolvedValue(undefined);
    const { onNotify, onChanged } = renderView([connection("a@example.com")]);

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(mocked.connectorDisconnect).toHaveBeenCalledWith("conn-1"),
    );
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("Imported data kept"),
    );
    expect(onChanged).toHaveBeenCalled();
  });
});
