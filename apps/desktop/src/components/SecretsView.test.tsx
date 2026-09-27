import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { SecretListing } from "../lib/types";
import SecretsView from "./SecretsView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";

function listing(id: string, name: string, owner: string, accountId: string | null): SecretListing {
  return {
    entry: {
      secret: {
        id,
        project_id: accountId ? null : "project-1",
        service_project_id: null,
        account_id: accountId,
        kind: "password",
        name,
        preview: "co•••le",
        value_blind_index: `bi-${id}`,
        environment: "unknown",
        notes: null,
        created_at: AT,
        updated_at: AT,
      },
      client_unsafe: true,
      provider: "unknown",
      service_project_name: null,
    },
    owner,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Secrets", () => {
  it("lists a password on an account, which walking projects used to miss", async () => {
    mocked.listAllSecrets.mockResolvedValue([
      listing("s1", "Password", "Loopia · Domains", "acc-1"),
      listing("s2", "DATABASE_URL", "Storefront", null),
    ]);
    render(<SecretsView onNotify={vi.fn()} refreshKey={0} />);

    expect(await screen.findByText("Loopia · Domains")).toBeInTheDocument();
    expect(screen.getByText("Storefront")).toBeInTheDocument();
    expect(mocked.listProjects).not.toHaveBeenCalled();
  });

  it("asks before destroying a secret", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocked.listAllSecrets.mockResolvedValue([listing("s1", "Password", "Loopia · Domains", "acc-1")]);
    render(<SecretsView onNotify={vi.fn()} refreshKey={0} />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("cannot be recovered"));
    expect(mocked.deleteSecret).not.toHaveBeenCalled();
  });
});
