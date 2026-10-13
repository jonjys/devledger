import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { recommendedLayout, templateCode, type Layout } from "../lib/layout";
import LayoutPanel from "./LayoutPanel";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

function Harness({ initial, onSaved }: { initial: Layout; onSaved: (l: Layout) => void }) {
  const [layout, setLayout] = useState(initial);
  return (
    <LayoutPanel
      layout={layout}
      onLayout={(l) => {
        setLayout(l);
        onSaved(l);
      }}
      onClose={vi.fn()}
      onNotify={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("templates", () => {
  it("uses a ready-made template only after saying what it replaces", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const saved: Layout[] = [];
    const start = recommendedLayout();
    start.boxes[1] = { ...start.boxes[1]!, text: "my plans" };
    render(<Harness initial={start} onSaved={(l) => saved.push(l)} />);

    await user.click(screen.getByRole("button", { name: "Use Minimal" }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("including a note"));
    expect(saved).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Use Minimal" }));
    expect(saved.at(-1)!.boxes.map((b) => b.kind)).toEqual(["note", "projects"]);
    expect(saved.at(-1)!.start).toBe("home");
  });

  it("saves the current layout as your own, shares it as a code and imports one", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const saved: Layout[] = [];
    render(<Harness initial={recommendedLayout()} onSaved={(l) => saved.push(l)} />);

    await user.click(screen.getByRole("button", { name: "Save current layout as a template" }));
    await user.type(screen.getByLabelText("Name"), "Launch week");
    await user.click(screen.getByRole("button", { name: "Save template" }));
    expect(saved.at(-1)!.templates.map((t) => t.name)).toEqual(["Launch week"]);

    await user.click(screen.getByRole("button", { name: "Share Launch week" }));
    const code = vi.mocked(writeText).mock.calls[0]![0];
    expect(code.startsWith("devledger-template:")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Import template" }));
    await user.type(screen.getByLabelText("Template code"), "nonsense");
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(saved.at(-1)!.templates).toHaveLength(1);

    const shared = templateCode({ id: "x", name: "From a friend", boxes: [{ id: "a", kind: "costs" }] });
    await user.clear(screen.getByLabelText("Template code"));
    await user.click(screen.getByLabelText("Template code"));
    await user.paste(shared);
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(saved.at(-1)!.templates.map((t) => t.name)).toEqual(["Launch week", "From a friend"]);
  });

  it("asks before sharing a template whose notes have text", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const l = recommendedLayout();
    l.templates = [{ id: "t", name: "Private", boxes: [{ id: "n", kind: "note", text: "pin 1234" }] }];
    render(<Harness initial={l} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Share Private" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("includes the text"));
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("the menu", () => {
  it("reorders, hides and restores tabs, and keeps Home", async () => {
    const user = userEvent.setup();
    const saved: Layout[] = [];
    render(<Harness initial={recommendedLayout()} onSaved={(l) => saved.push(l)} />);
    await user.click(screen.getByRole("tab", { name: "Menu" }));

    await user.click(screen.getByRole("button", { name: "Move Home up" }));
    expect(saved.at(-1)!.tabs.slice(0, 4)).toEqual(["projects", "ledger", "home", "assistant"]);

    await user.click(screen.getByRole("button", { name: "Hide Secrets" }));
    expect(saved.at(-1)!.tabs).not.toContain("secrets");
    expect(screen.getByRole("button", { name: "Hide Home" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "+ Secrets" }));
    expect(saved.at(-1)!.tabs.at(-1)).toBe("secrets");

    await user.selectOptions(screen.getByLabelText("Start page"), "home");
    expect(saved.at(-1)!.start).toBe("home");
  });

  it("moves the start page when its tab is hidden", async () => {
    const user = userEvent.setup();
    const saved: Layout[] = [];
    render(<Harness initial={recommendedLayout()} onSaved={(l) => saved.push(l)} />);
    await user.click(screen.getByRole("tab", { name: "Menu" }));
    await user.click(screen.getByRole("button", { name: "Hide Projects" }));
    expect(saved.at(-1)!.start).toBe("ledger");
    const list = screen.getByRole("list");
    expect(within(list).queryByText("Projects")).toBeNull();
  });
});
