import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { Account, IdentityNode } from "../lib/types";
import MapView from "./MapView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);

function account(id: string, label: string, provider: Account["provider"]): Account {
  return {
    id,
    identity_id: "identity-1",
    provider,
    external_ref: null,
    label,
    created_at: "2026-09-16T10:00:00Z",
  };
}

function graph(): IdentityNode[] {
  return [
    {
      identity: {
        id: "identity-1",
        label: "fkornelind@hotmail.com",
        email: "fkornelind@hotmail.com",
        email_blind_index: null,
        created_at: "2026-09-16T10:00:00Z",
      },
      accounts: [
        {
          account: account("account-1", "fkornelind", "git_hub"),
          organizations: [],
          unassigned: [],
          subscriptions: [],
        },
      ],
    },
    {
      identity: {
        id: "identity-2",
        label: "work@example.com",
        email: "work@example.com",
        email_blind_index: null,
        created_at: "2026-09-16T10:00:00Z",
      },
      accounts: [],
    },
  ];
}

function renderMap() {
  mocked.identityGraph.mockResolvedValue(graph());
  mocked.needsAttention.mockResolvedValue([]);
  const onNotify = vi.fn();
  const onChanged = vi.fn();
  render(<MapView projects={[]} onNotify={onNotify} onChanged={onChanged} />);
  return { onNotify, onChanged };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Skill tree map", () => {
  it("renders identities and their provider accounts", async () => {
    renderMap();
    expect(await screen.findByRole("heading", { name: "Skill tree" })).toBeInTheDocument();
    expect(screen.getByText("fkornelind")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("adds a child account under an identity", async () => {
    mocked.addAccount.mockResolvedValue(account("account-2", "second", "vercel"));
    const user = userEvent.setup();
    renderMap();

    const identityHead = (
      await screen.findByText("fkornelind@hotmail.com", { selector: ".map-name" })
    ).closest(".map-head") as HTMLElement;
    await user.click(within(identityHead).getByRole("button", { name: "+ Child node" }));
    await user.type(screen.getByLabelText("Account label"), "second");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mocked.addAccount).toHaveBeenCalled());
    // Provider defaults to the serde snake_case GitHub tag.
    expect(mocked.addAccount).toHaveBeenCalledWith("identity-1", "git_hub", "second", null);
  });

  it("re-parents an account to another identity", async () => {
    mocked.moveAccount.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderMap();

    await screen.findByText("fkornelind");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Move to identity" }),
      "identity-2",
    );

    await waitFor(() => expect(mocked.moveAccount).toHaveBeenCalledWith("account-1", "identity-2"));
  });

  it("deletes an account after confirmation", async () => {
    mocked.deleteAccount.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderMap();

    await screen.findByText("fkornelind");
    await user.click(screen.getByRole("button", { name: "Delete account fkornelind" }));

    await waitFor(() => expect(mocked.deleteAccount).toHaveBeenCalledWith("account-1"));
  });
});
