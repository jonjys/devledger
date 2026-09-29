import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { Account, AttentionItem, Identity, ServiceProjectSummary } from "../lib/types";
import AttentionView from "./AttentionView";

vi.mock("../lib/api");
const mocked = vi.mocked(api);
const AT = "2026-09-27T10:00:00Z";

const NO_EMAIL: AttentionItem = {
  kind: "identity_without_email",
  title: "Unidentified has no email",
  detail: "Accounts under it are not filed under anyone.",
  entity: { kind: "identity", id: "id-none" },
};

function identity(id: string, email: string | null): Identity {
  return { id, label: email ?? "Unidentified", email, email_blind_index: null, created_at: AT };
}

function account(id: string): Account {
  return {
    id,
    identity_id: "id-none",
    provider: "other:Loopia",
    external_ref: null,
    label: "Loopia",
    login_email: null,
    username: null,
    url: null,
    notes: null,
    created_at: AT,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Needs attention", () => {
  it("puts an entry with no email first, pulsing, with a way to move its accounts", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mocked.needsAttention.mockResolvedValue([
      { kind: "orphan_secret", title: "A loose key", detail: "", entity: { kind: "secret", id: "s1" } },
      NO_EMAIL,
    ]);
    mocked.listIdentities.mockResolvedValue([identity("id-none", null), identity("id-me", "primary@example.com")]);
    mocked.accountsForIdentity.mockResolvedValue([account("a1"), account("a2")]);

    render(<AttentionView onNotify={vi.fn()} refreshKey={0} onChanged={onChanged} />);

    const row = await screen.findByLabelText("No email");
    expect(row).toHaveClass("pulse");
    const titles = screen.getAllByText(/has no email|A loose key/).map((el) => el.textContent);
    expect(titles[0]).toBe("Unidentified has no email");

    expect(within(row).getByLabelText("Move to identity")).toHaveValue("id-me");
    await user.click(await within(row).findByRole("button", { name: "Move 2 accounts" }));
    await waitFor(() => expect(mocked.moveAccount).toHaveBeenCalledTimes(2));
    expect(mocked.moveAccount).toHaveBeenCalledWith("a1", "id-me");
    expect(mocked.moveAccount).toHaveBeenCalledWith("a2", "id-me");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers to delete the entry once it holds nothing", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocked.needsAttention.mockResolvedValue([NO_EMAIL]);
    mocked.listIdentities.mockResolvedValue([identity("id-none", null), identity("id-me", "primary@example.com")]);
    mocked.accountsForIdentity.mockResolvedValue([]);

    render(<AttentionView onNotify={vi.fn()} refreshKey={0} />);
    await user.click(await screen.findByRole("button", { name: "Delete empty entry" }));
    await waitFor(() => expect(mocked.deleteIdentity).toHaveBeenCalledWith("id-none"));
  });

  it("removes the entry itself once its accounts have moved", async () => {
    const user = userEvent.setup();
    mocked.needsAttention.mockResolvedValue([NO_EMAIL]);
    mocked.listIdentities.mockResolvedValue([identity("id-none", null), identity("id-me", "primary@example.com")]);
    // Before the move: one account. After it: none left.
    mocked.accountsForIdentity
      .mockResolvedValueOnce([account("a1")])
      .mockResolvedValueOnce([account("a1")])
      .mockResolvedValue([]);

    render(<AttentionView onNotify={vi.fn()} refreshKey={0} />);
    await user.click(await screen.findByRole("button", { name: "Move 1 account" }));
    await waitFor(() => expect(mocked.deleteIdentity).toHaveBeenCalledWith("id-none"));
    expect(mocked.moveAccount).toHaveBeenCalledWith("a1", "id-me");
  });

  it("files a resource with no organization under a newly named one", async () => {
    const user = userEvent.setup();
    mocked.needsAttention.mockResolvedValue([
      {
        kind: "unassigned_organization",
        title: "abcdefghijklmnopqrst has no organization",
        detail: "",
        entity: { kind: "service_project", id: "sp1" },
      },
    ]);
    mocked.listIdentities.mockResolvedValue([]);
    mocked.listServiceProjects.mockResolvedValue([
      {
        service_project: {
          id: "sp1",
          account_id: "acc1",
          organization_id: null,
          provider: "supabase",
          provider_ref: "abcdefghijklmnopqrst",
          name: "abcdefghijklmnopqrst",
          region: null,
          environment: "unknown",
          url: null,
          notes: null,
          created_at: AT,
        },
        account_label: "Supabase",
        identity_email: null,
        organization_name: null,
        secret_count: 1,
        used_by: [],
      } satisfies ServiceProjectSummary,
    ]);
    mocked.organizationsForAccount.mockResolvedValue([]);
    mocked.createOrganization.mockResolvedValue({
      id: "org1",
      account_id: "acc1",
      provider_org_id: null,
      name: "Acme Org",
      created_at: AT,
    });

    render(<AttentionView onNotify={vi.fn()} refreshKey={0} />);
    await user.type(await screen.findByLabelText("Organization name"), "Acme Org");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.assignOrganization).toHaveBeenCalledWith("sp1", "org1"));
    expect(mocked.createOrganization).toHaveBeenCalledWith("acc1", "Acme Org");
  });
});
