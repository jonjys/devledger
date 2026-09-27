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

  it("shows Supabase as an ordinary card, with no separate discovery section", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Add a service" });
    expect(screen.queryByRole("heading", { name: /Automatic discovery/ })).not.toBeInTheDocument();

    const supabase = catalogCard("Supabase");
    expect(within(supabase).getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(within(supabase).getByText("DevLedger only reads")).toBeInTheDocument();
    // Its logo is drawn from the bundled icon set, not fetched.
    expect(within(supabase).getByRole("img", { name: "Supabase" })).toBeInTheDocument();
  });

  it("files a catalog service under its own name, never under the label typed", async () => {
    const user = userEvent.setup();
    const { onNotify } = renderView();
    mocked.createAccountForEmail.mockResolvedValue({
      id: "account-3",
      identity_id: "identity-1",
      provider: "other:Resend",
      external_ref: null,
      label: "test@example.com",
      login_email: null,
      username: null,
      url: null,
      notes: null,
      created_at: "2026-09-27T10:00:00Z",
    });
    await screen.findByRole("heading", { name: "Add a service" });
    await user.click(within(catalogCard("Resend")).getByRole("button", { name: "+ Add" }));
    await user.click(screen.getByRole("tab", { name: "Manual Connection" }));
    await user.type(screen.getByLabelText("Account email"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Save account" }));

    await waitFor(() =>
      expect(mocked.createAccountForEmail).toHaveBeenCalledWith(
        "test@example.com",
        "other:Resend",
        "test@example.com",
        null,
      ),
    );
    expect(onNotify).toHaveBeenCalledWith("Saved Resend account");
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
