import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { CustomField } from "../lib/types";
import FieldsEditor from "./FieldsEditor";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";
const onAccount = { kind: "account" as const, id: "acc-1" };
const owner = { project_id: null, service_project_id: null, account_id: "acc-1" };

function field(id: string, label: string, value: string): CustomField {
  return { id, entity: onAccount, label, value, position: 0, created_at: AT, updated_at: AT };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Custom fields", () => {
  it("shows the fields the user named, in the clear", async () => {
    mocked.customFields.mockResolvedValue([
      field("f1", "Customer number", "LP-448812"),
      field("f2", "Forum username", "acme_dev"),
    ]);
    render(<FieldsEditor entity={onAccount} onNotify={vi.fn()} />);

    expect(await screen.findByText("Customer number")).toBeInTheDocument();
    expect(screen.getByText("LP-448812")).toBeInTheDocument();
    expect(screen.getByText("Forum username")).toBeInTheDocument();
    expect(screen.getByText("acme_dev")).toBeInTheDocument();
  });

  it("adds a field with any name the user types", async () => {
    const user = userEvent.setup();
    mocked.customFields.mockResolvedValue([]);
    mocked.addCustomField.mockResolvedValue(field("f1", "Project", "Storefront"));
    render(<FieldsEditor entity={onAccount} secretOwner={owner} onNotify={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "+ Field" }));
    const form = screen.getByRole("form", { name: "New field" });
    await user.type(within(form).getByLabelText("Field name"), "Project");
    await user.type(within(form).getByLabelText("Field value"), "Storefront");
    await user.click(within(form).getByRole("button", { name: "Add field" }));

    await waitFor(() =>
      expect(mocked.addCustomField).toHaveBeenCalledWith(onAccount, "Project", "Storefront"),
    );
    expect(mocked.storeSecret).not.toHaveBeenCalled();
  });

  it("stores a hidden field as a sealed secret instead of a visible field", async () => {
    const user = userEvent.setup();
    mocked.customFields.mockResolvedValue([]);
    mocked.storeSecret.mockResolvedValue({} as never);
    const onSecretStored = vi.fn();
    render(
      <FieldsEditor
        entity={onAccount}
        secretOwner={owner}
        onNotify={vi.fn()}
        onSecretStored={onSecretStored}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "+ Field" }));
    const form = screen.getByRole("form", { name: "New field" });
    await user.type(within(form).getByLabelText("Field name"), "Support PIN");
    await user.click(within(form).getByLabelText(/Hide value/));
    const value = within(form).getByLabelText("Field value");
    expect(value).toHaveAttribute("type", "password");
    await user.type(value, "9876");
    await user.click(within(form).getByRole("button", { name: "Add field" }));

    await waitFor(() =>
      expect(mocked.storeSecret).toHaveBeenCalledWith(
        { owner, kind: "env_var", name: "Support PIN", environment: "unknown", notes: null },
        "9876",
      ),
    );
    expect(mocked.addCustomField).not.toHaveBeenCalled();
    expect(onSecretStored).toHaveBeenCalled();
  });

  it("offers no hiding where there is nowhere to seal a secret", async () => {
    const user = userEvent.setup();
    mocked.customFields.mockResolvedValue([]);
    render(
      <FieldsEditor entity={{ kind: "identity", id: "person-1" }} onNotify={vi.fn()} />,
    );

    await user.click(await screen.findByRole("button", { name: "+ Field" }));
    expect(screen.queryByLabelText(/Hide value/)).toBeNull();
  });

  it("edits and removes a field", async () => {
    const user = userEvent.setup();
    mocked.customFields.mockResolvedValue([field("f1", "Pin", "1234")]);
    mocked.updateCustomField.mockResolvedValue(undefined);
    mocked.deleteCustomField.mockResolvedValue(undefined);
    render(<FieldsEditor entity={onAccount} onNotify={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Edit Pin" }));
    const form = screen.getByRole("form", { name: "Edit field" });
    const name = within(form).getByLabelText("Field name");
    await user.clear(name);
    await user.type(name, "Support PIN");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocked.updateCustomField).toHaveBeenCalledWith("f1", "Support PIN", "1234"),
    );

    await user.click(await screen.findByRole("button", { name: "Remove Pin" }));
    await waitFor(() => expect(mocked.deleteCustomField).toHaveBeenCalledWith("f1"));
  });
});
