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

  it("saves a GitHub account manually as git_hub, not github", async () => {
    const user = userEvent.setup();
    mocked.createAccountManual.mockResolvedValue({
      id: "account-1",
      identity_id: "identity-1",
      provider: "git_hub",
      external_ref: "github.com/fkornelind",
      label: "fkornelind@hotmail.com",
      created_at: "2026-09-16T10:00:00Z",
    });
    const { onChanged } = renderView();

    await screen.findByRole("heading", { name: "Add a service" });
    await user.click(within(catalogCard("GitHub")).getByRole("button", { name: "+ Add" }));
    const dialog = screen.getByRole("dialog", { name: "Add GitHub" });
    await user.click(within(dialog).getByRole("tab", { name: "Manual Connection" }));
    await user.type(within(dialog).getByLabelText("Account email"), "fkornelind@hotmail.com");
    await user.type(
      within(dialog).getByLabelText("Custom note / link"),
      "github.com/fkornelind",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save account" }));

    await waitFor(() => expect(mocked.createAccountManual).toHaveBeenCalled());
    // The bug this fixes: the provider tag must be the serde snake_case form.
    expect(mocked.createAccountManual).toHaveBeenCalledWith(
      "fkornelind@hotmail.com",
      "git_hub",
      "fkornelind@hotmail.com",
      "github.com/fkornelind",
    );
    expect(onChanged).toHaveBeenCalled();
  });
});
