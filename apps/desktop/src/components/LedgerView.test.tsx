import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type {
  Account,
  AccountNode,
  IdentityEmail,
  LedgerIdentity,
  Provider,
  ServiceProjectSummary,
  VaultEntry,
} from "../lib/types";
import LedgerView from "./LedgerView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";

function email(id: string, address: string, isPrimary: boolean): IdentityEmail {
  return {
    id,
    identity_id: "person-1",
    address,
    blind_index: `bi-${id}`,
    is_primary: isPrimary,
    created_at: AT,
  };
}

function account(id: string, label: string, provider: Provider, login: string | null): Account {
  return {
    id,
    identity_id: "person-1",
    provider,
    external_ref: null,
    label,
    login_email: login,
    username: null,
    url: null,
    notes: null,
    created_at: AT,
  };
}

function resource(id: string, name: string, accountId: string, usedBy: string[]): ServiceProjectSummary {
  return {
    service_project: {
      id,
      account_id: accountId,
      organization_id: null,
      provider: "supabase",
      provider_ref: null,
      name,
      region: null,
      environment: "production",
      url: null,
      notes: null,
      created_at: AT,
    },
    account_label: "",
    identity_email: null,
    organization_name: null,
    secret_count: 1,
    used_by: usedBy.map((n, i) => ({ id: `project-${i}`, name: n })),
  };
}

function node(acc: Account, resources: ServiceProjectSummary[] = []): AccountNode {
  return { account: acc, organizations: [], unassigned: resources, subscriptions: [] };
}

/**
 * The scenario the model exists for: one person, two addresses, a Supabase
 * account under each, and one project drawing on both.
 */
function twoAddressPerson(): LedgerIdentity {
  return {
    identity: {
      id: "person-1",
      label: "Me",
      email: "work@example.com",
      email_blind_index: "bi-1",
      created_at: AT,
    },
    emails: [email("e1", "work@example.com", true), email("e2", "personal@example.com", false)],
    accounts: [
      node(account("acc-work", "Supabase (work)", "supabase", "work@example.com"), [
        resource("sp-api", "storefront-api", "acc-work", ["Storefront"]),
      ]),
      node(account("acc-personal", "Supabase (personal)", "supabase", "personal@example.com"), [
        resource("sp-stats", "storefront-stats", "acc-personal", ["Storefront"]),
      ]),
      node(account("acc-reg", "Domains", "other:Loopia", "billing@example.com")),
    ],
    projects: [{ id: "project-0", name: "Storefront" }],
    secret_count: 3,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

function renderLedger() {
  const onNotify = vi.fn();
  const onChanged = vi.fn();
  render(<LedgerView onNotify={onNotify} onChanged={onChanged} />);
  return { onNotify, onChanged };
}

describe("Ledger", () => {
  it("shows the chain from each address down to the project", async () => {
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    renderLedger();

    const person = await screen.findByRole("region", { name: "Person Me" });
    const addresses = within(person).getByRole("list", { name: "Addresses of Me" });
    expect(within(addresses).getByText("work@example.com")).toBeInTheDocument();
    expect(within(addresses).getByText("personal@example.com")).toBeInTheDocument();
    expect(within(addresses).getAllByText("primary")).toHaveLength(1);

    // Two accounts with the same provider stay two accounts.
    expect(within(person).getByText("Supabase (work)")).toBeInTheDocument();
    expect(within(person).getByText("Supabase (personal)")).toBeInTheDocument();

    // And the one project they both feed is shown once.
    expect(within(person).getAllByText("Storefront")).toHaveLength(1);
  });

  it("labels a service DevLedger does not know by the name the user gave it", async () => {
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    renderLedger();

    const card = await screen.findByLabelText("Account Domains");
    expect(within(card).getByText("Loopia")).toBeInTheDocument();
    expect(within(card).getByText("custom service")).toBeInTheDocument();
    expect(within(card).getByText("billing@example.com")).toBeInTheDocument();
  });

  it("adds a person by address", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([]);
    mocked.createIdentityManual.mockResolvedValue(twoAddressPerson().identity);
    renderLedger();

    await user.click(await screen.findByRole("button", { name: "+ Person" }));
    await user.type(screen.getByLabelText("Email address"), "work@example.com");
    await user.click(screen.getByRole("button", { name: "Add person" }));

    await waitFor(() =>
      expect(mocked.createIdentityManual).toHaveBeenCalledWith("", "work@example.com"),
    );
  });

  it("adds another address to an existing person", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.addIdentityEmail.mockResolvedValue(email("e3", "old@example.com", false));
    renderLedger();

    const person = await screen.findByRole("region", { name: "Person Me" });
    await user.click(within(person).getByRole("button", { name: "+ Address" }));
    await user.type(within(person).getByLabelText("New address"), "old@example.com");
    await user.click(within(person).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocked.addIdentityEmail).toHaveBeenCalledWith("person-1", "old@example.com", false),
    );
  });

  it("promotes a second address to primary", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.setPrimaryEmail.mockResolvedValue(undefined);
    renderLedger();

    const person = await screen.findByRole("region", { name: "Person Me" });
    await user.click(within(person).getByRole("button", { name: "Make primary" }));

    await waitFor(() => expect(mocked.setPrimaryEmail).toHaveBeenCalledWith("person-1", "e2"));
  });

  it("creates an account with any service, recording how to sign in", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.createAccountManual.mockResolvedValue(
      account("acc-new", "Home", "other:My NAS", "work@example.com"),
    );
    renderLedger();

    const person = await screen.findByRole("region", { name: "Person Me" });
    await user.click(within(person).getByRole("button", { name: "+ Account" }));
    const form = within(person).getByRole("form", { name: "New account" });
    await user.type(within(form).getByLabelText("Service"), "My NAS");
    expect(within(form).getByText(/custom service, "My NAS"/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Label"), "Home");
    await user.type(within(form).getByLabelText("Username"), "root");
    await user.click(within(form).getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(mocked.createAccountManual).toHaveBeenCalledWith(
        "person-1",
        "other:My NAS",
        "Home",
        {
          login_email: "work@example.com",
          username: "root",
          url: null,
          notes: null,
        },
      ),
    );
  });

  it("recognises a known service however it is typed", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.createAccountManual.mockResolvedValue(account("a", "x", "supabase", null));
    renderLedger();

    const person = await screen.findByRole("region", { name: "Person Me" });
    await user.click(within(person).getByRole("button", { name: "+ Account" }));
    const form = within(person).getByRole("form", { name: "New account" });
    await user.type(within(form).getByLabelText("Service"), "SUPABASE");
    await user.click(within(form).getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(mocked.createAccountManual).toHaveBeenCalled());
    expect(mocked.createAccountManual.mock.calls[0]?.[1]).toBe("supabase");
  });
});

describe("Account card", () => {
  const stored: VaultEntry = {
    secret: {
      id: "s-1",
      project_id: null,
      service_project_id: null,
      account_id: "acc-reg",
      kind: "password",
      name: "Password",
      preview: "co•••••le",
      value_blind_index: "bi",
      environment: "unknown",
      notes: null,
      created_at: AT,
      updated_at: AT,
    },
    client_unsafe: true,
    provider: "unknown",
    service_project_name: null,
  };

  it("stores a password on the account, sealed, and clears the typed value", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.accountSecrets.mockResolvedValue([]);
    mocked.storeSecret.mockResolvedValue(stored.secret);
    renderLedger();

    const card = await screen.findByLabelText("Account Domains");
    await user.click(within(card).getByRole("button", { name: "Expand Domains" }));
    await user.click(await within(card).findByRole("button", { name: "+ Password or key" }));

    const form = within(card).getByRole("form", { name: "New credential" });
    const valueInput = within(form).getByLabelText("Secret value");
    expect(valueInput).toHaveAttribute("type", "password");
    await user.type(valueInput, "correct horse battery staple");
    await user.click(within(form).getByRole("button", { name: "Store encrypted" }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        {
          owner: { project_id: null, service_project_id: null, account_id: "acc-reg" },
          kind: "password",
          name: "Password",
          environment: "unknown",
          notes: null,
        },
        "correct horse battery staple",
      ),
    );
  });

  it("shows only a mask until Reveal, and forgets the value when collapsed", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.accountSecrets.mockResolvedValue([stored]);
    mocked.revealSecret.mockResolvedValue("correct horse battery staple");
    renderLedger();

    const card = await screen.findByLabelText("Account Domains");
    await user.click(within(card).getByRole("button", { name: "Expand Domains" }));
    expect(await within(card).findByText("co•••••le")).toBeInTheDocument();
    expect(within(card).queryByText("correct horse battery staple")).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Reveal" }));
    expect(await within(card).findByText("correct horse battery staple")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Collapse Domains" }));
    await user.click(within(card).getByRole("button", { name: "Expand Domains" }));
    await within(card).findByText("co•••••le");
    expect(within(card).queryByText("correct horse battery staple")).toBeNull();
  });

  it("copies without the value ever reaching the page", async () => {
    const user = userEvent.setup();
    mocked.ledgerOverview.mockResolvedValue([twoAddressPerson()]);
    mocked.accountSecrets.mockResolvedValue([stored]);
    mocked.copySecret.mockResolvedValue(undefined);
    renderLedger();

    const card = await screen.findByLabelText("Account Domains");
    await user.click(within(card).getByRole("button", { name: "Expand Domains" }));
    await user.click(await within(card).findByRole("button", { name: "Copy" }));

    await waitFor(() => expect(mocked.copySecret).toHaveBeenCalledWith("s-1"));
    expect(mocked.revealSecret).not.toHaveBeenCalled();
  });
});
