import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import { supabaseConnector } from "../test/connect-fixtures";
import ConnectionsView from "./ConnectionsView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);

function renderView() {
  mocked.listConnectors.mockResolvedValue([supabaseConnector()]);
  mocked.listConnections.mockResolvedValue([]);
  mocked.identityGraph.mockResolvedValue([]);
  const onNotify = vi.fn();
  const onChanged = vi.fn();
  render(<ConnectionsView onNotify={onNotify} onChanged={onChanged} />);
  return { onNotify, onChanged };
}

function catalogCard(name: string): HTMLElement {
  return screen.getByText(name).closest(".catalog-card") as HTMLElement;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Service catalog", () => {
  it("lists services that can be added by hand", async () => {
    renderView();
    expect(await screen.findByRole("heading", { name: "Add a service" })).toBeInTheDocument();
    for (const name of ["GitHub", "Vercel", "Stripe", "OpenAI", "Anthropic", "AWS"]) {
      expect(within(catalogCard(name)).getByRole("button", { name: "+ Add" })).toBeInTheDocument();
    }
  });

  it("opens a two-tab modal from a catalog card", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("heading", { name: "Add a service" });
    await user.click(within(catalogCard("GitHub")).getByRole("button", { name: "+ Add" }));

    const dialog = screen.getByRole("dialog", { name: "Add GitHub" });
    expect(within(dialog).getByRole("tab", { name: "API Connection" })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "Manual Connection" })).toBeInTheDocument();
  });

  it("saves a GitHub account manually under the canonical github tag", async () => {
    const user = userEvent.setup();
    mocked.createAccountForEmail.mockResolvedValue({
      id: "account-1",
      identity_id: "identity-1",
      provider: "github",
      external_ref: "github.com/test",
      label: "test@gmail.com",
      login_email: null,
      username: null,
      url: null,
      notes: null,
      created_at: "2026-09-16T10:00:00Z",
    });
    const { onChanged } = renderView();

    await screen.findByRole("heading", { name: "Add a service" });
    await user.click(within(catalogCard("GitHub")).getByRole("button", { name: "+ Add" }));
    const dialog = screen.getByRole("dialog", { name: "Add GitHub" });
    await user.click(within(dialog).getByRole("tab", { name: "Manual Connection" }));
    await user.type(within(dialog).getByLabelText("Account email"), "test@gmail.com");
    await user.type(
      within(dialog).getByLabelText("Custom note / link"),
      "github.com/test",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save account" }));

    await waitFor(() => expect(mocked.createAccountForEmail).toHaveBeenCalled());
    // One spelling crosses IPC now: the same key the database stores. The
    // backend also accepts the older `git_hub`, which a Rust test pins down.
    expect(mocked.createAccountForEmail).toHaveBeenCalledWith(
      "test@gmail.com",
      "github",
      "test@gmail.com",
      "github.com/test",
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("stores a key typed for a service with no connector instead of discarding it", async () => {
    // The API tab requires a key before it will submit. It used to create the
    // account and then drop the key while reporting success, so people believed
    // it was stored. It is now sealed onto the new account.
    const user = userEvent.setup();
    mocked.createAccountForEmail.mockResolvedValue({
      id: "account-9",
      identity_id: "identity-1",
      provider: "stripe",
      external_ref: null,
      label: "Billing",
      login_email: null,
      username: null,
      url: null,
      notes: null,
      created_at: "2026-09-16T10:00:00Z",
    });
    mocked.storeSecret.mockResolvedValue({} as never);
    const { onNotify } = renderView();

    await screen.findByRole("heading", { name: "Add a service" });
    await user.click(within(catalogCard("Stripe")).getByRole("button", { name: "+ Add" }));
    const dialog = screen.getByRole("dialog", { name: "Add Stripe" });
    await user.type(within(dialog).getByLabelText("Label this account"), "Billing");
    await user.type(within(dialog).getByLabelText("API key / token"), "sk_live_example");
    await user.click(within(dialog).getByRole("button", { name: /save|add|connect/i }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        {
          owner: { project_id: null, service_project_id: null, account_id: "account-9" },
          kind: "generic_api_key",
          name: "Stripe API key",
          environment: "unknown",
          notes: null,
        },
        "sk_live_example",
      ),
    );
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("not verified"));
  });

  it("lists manual services before the optional automatic connectors", async () => {
    renderView();
    const manual = await screen.findByRole("heading", { name: "Add a service" });
    const automatic = await screen.findByRole("heading", {
      name: "Automatic discovery — optional",
    });
    // DOCUMENT_POSITION_FOLLOWING: the automatic section comes after.
    expect(manual.compareDocumentPosition(automatic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers a card for any service that is not listed", async () => {
    const user = userEvent.setup();
    mocked.listConnectors.mockResolvedValue([supabaseConnector()]);
    mocked.listConnections.mockResolvedValue([]);
    mocked.identityGraph.mockResolvedValue([]);
    const onAddOther = vi.fn();
    render(<ConnectionsView onNotify={vi.fn()} onChanged={vi.fn()} onAddOther={onAddOther} />);

    await screen.findByRole("heading", { name: "Add a service" });
    await user.click(within(catalogCard("Something else")).getByRole("button", { name: "+ Add" }));
    expect(onAddOther).toHaveBeenCalled();
  });
});
