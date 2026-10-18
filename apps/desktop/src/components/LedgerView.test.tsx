import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import LedgerView from "./LedgerView";

vi.mock("./LedgerCanvas", () => ({ default: () => <div data-testid="map" /> }));
vi.mock("./LedgerList", () => ({ default: () => <div data-testid="list" /> }));

const width = (w: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: w });

afterEach(() => {
  window.localStorage.clear();
  width(1024);
});

describe("the Ledger's first view", () => {
  it("opens as the map on a desk", async () => {
    width(1280);
    render(<LedgerView onNotify={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId("map")).toBeInTheDocument();
  });

  it("opens as the list on a phone, and never offers the map", async () => {
    width(390);
    render(<LedgerView onNotify={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByTestId("list")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Map" })).toBeNull();
    expect(screen.queryByTestId("map")).toBeNull();
  });
});
