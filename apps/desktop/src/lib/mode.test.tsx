import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MODE_SWITCH_SHOWN, ModeProvider, useMode } from "./mode";

function Show() {
  return <span>{useMode().mode}</span>;
}

afterEach(() => {
  window.localStorage.clear();
});

describe("display mode", () => {
  it("is Indie while the switch is hidden, even for someone who chose Dev before", () => {
    expect(MODE_SWITCH_SHOWN).toBe(false);
    window.localStorage.setItem("devledger.mode", "dev");
    render(
      <ModeProvider>
        <Show />
      </ModeProvider>,
    );
    expect(screen.getByText("indie")).toBeInTheDocument();
  });
});
