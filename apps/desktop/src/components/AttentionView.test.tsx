import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { Account, AttentionItem, Identity } from "../lib/types";
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
});
