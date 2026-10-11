import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import * as api from "../lib/api";
import AssistantView from "./AssistantView";

vi.mock("../lib/api");
const mocked = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
  mocked.listAllSecrets.mockResolvedValue([]);
});

describe("Assistant", () => {
  it("asks for an Anthropic key first, and seals it through Rust", async () => {
    mocked.assistantStatus.mockResolvedValue({ enabled: false, model: "claude-opus-5-5" });
    mocked.assistantSetKey.mockResolvedValue({ enabled: true, model: "claude-opus-5-5" });
    const user = userEvent.setup();
    render(<AssistantView onNotify={vi.fn()} />);
    await user.type(await screen.findByLabelText("Anthropic API key"), "sk-ant-test");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(mocked.assistantSetKey).toHaveBeenCalledWith("sk-ant-test");
    expect(await screen.findByRole("button", { name: "Review now" })).toBeInTheDocument();
  });

  it("shows exactly what is sent, then the answer", async () => {
    mocked.assistantStatus.mockResolvedValue({ enabled: true, model: "claude-opus-5-5" });
    mocked.assistantPreview.mockResolvedValue({ system: "s", user: "# Ledger outline\n- K1 STRIPE_SECRET_KEY", addresses_hidden: 2 });
    mocked.assistantAsk.mockResolvedValue({
      text: "## Do this first\n1. Roll **STRIPE_SECRET_KEY**",
      model: "claude-opus-5-5",
      input_tokens: 900,
      output_tokens: 200,
      truncated: false,
    });
    const user = userEvent.setup();
    render(<AssistantView onNotify={vi.fn()} />);
    const [firstPreview] = await screen.findAllByRole("button", { name: "What is sent?" });
    await user.click(firstPreview!);
    expect(await screen.findByText(/K1 STRIPE_SECRET_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/2 email addresses/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Review now" }));
    await waitFor(() => expect(mocked.assistantAsk).toHaveBeenCalledWith({ task: "review" }));
    expect(await screen.findByRole("heading", { name: "Do this first" })).toBeInTheDocument();
    expect(screen.getByText("STRIPE_SECRET_KEY", { selector: "strong" })).toBeInTheDocument();
  });

  it("opens on a leaked key when sent from the Secrets page", async () => {
    mocked.assistantStatus.mockResolvedValue({ enabled: true, model: "claude-opus-5-5" });
    mocked.listAllSecrets.mockResolvedValue([
      {
        owner: "Shop",
        entry: {
          client_unsafe: true,
          provider: "stripe",
          service_project_name: null,
          secret: {
            id: "k1",
            project_id: "p1",
            service_project_id: null,
            account_id: null,
            kind: "stripe_secret_key",
            name: "STRIPE_SECRET_KEY",
            preview: "sk_l…6789",
            value_blind_index: "x",
            environment: "production",
            notes: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      },
    ]);
    render(<AssistantView onNotify={vi.fn()} leakSecretId="k1" />);
    await waitFor(() =>
      expect((screen.getByLabelText("The key that leaked") as HTMLSelectElement).value).toBe("k1"),
    );
    expect(screen.getByRole("button", { name: "Make a plan" })).toBeEnabled();
  });
});
