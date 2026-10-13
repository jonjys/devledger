import {
  ALL_VIEWS,
  BUILTIN_TEMPLATES,
  LIMITS,
  applyTemplate,
  move,
  parseLayout,
  parseTemplate,
  recommendedLayout,
  serializeLayout,
  templateCode,
  templateFrom,
} from "./layout";

describe("layout", () => {
  it("gives a new vault the recommended layout, opening on Projects as before", () => {
    const l = parseLayout(null);
    expect(l.start).toBe("projects");
    expect(l.tabs).toEqual(["projects", "ledger", "assistant", "home", "connections", "subscriptions", "secrets", "attention"]);
    expect(l.boxes.length).toBeGreaterThan(3);
    expect(new Set(l.boxes.map((b) => b.id)).size).toBe(l.boxes.length);
  });

  it("round-trips a saved layout", () => {
    const l = recommendedLayout();
    l.boxes[1] = { ...l.boxes[1]!, title: "Mine", text: "- a\n- b" };
    expect(parseLayout(serializeLayout(l))).toEqual(l);
  });

  it("keeps only what it understands from a damaged or hostile document", () => {
    const l = parseLayout(
      JSON.stringify({
        boxes: [
          { id: "x", kind: "note", text: "y".repeat(LIMITS.text + 50), title: "t".repeat(200) },
          { id: "x", kind: "stats", wide: "yes" },
          { kind: "script", text: "<img onerror=alert(1)>" },
          null,
          ...Array.from({ length: 40 }, () => ({ kind: "costs" })),
        ],
        tabs: ["secrets", "secrets", "admin", "projects"],
        start: "admin",
        templates: [{ name: "" }, { name: "Ok", boxes: [{ kind: "note", text: "hi" }] }],
      }),
    );
    expect(l.boxes).toHaveLength(LIMITS.boxes);
    expect(l.boxes[0]!.text).toHaveLength(LIMITS.text);
    expect(l.boxes[0]!.title).toHaveLength(LIMITS.title);
    expect(l.boxes[1]!.wide).toBeUndefined();
    expect(l.boxes[1]!.id).not.toBe(l.boxes[0]!.id);
    expect(l.boxes.some((b) => (b.kind as string) === "script")).toBe(false);
    expect(l.tabs).toEqual(["home", "secrets", "projects"]);
    expect(l.start).toBe("home");
    expect(l.templates.map((t) => t.name)).toEqual(["Ok"]);
    expect(parseLayout("not json")).toEqual(expect.objectContaining({ start: "projects" }));
  });

  it("applies a template with fresh ids, its own tabs and start page", () => {
    const base = recommendedLayout();
    const t = BUILTIN_TEMPLATES.find((x) => x.id === "minimal")!;
    const l = applyTemplate(base, t);
    expect(l.boxes.map((b) => b.kind)).toEqual(t.boxes.map((b) => b.kind));
    expect(l.boxes.map((b) => b.id)).not.toEqual(t.boxes.map((b) => b.id));
    expect(l.tabs).toEqual(["home", "projects", "ledger"]);
    expect(l.start).toBe("home");
  });

  it("every built-in template only names real tabs and boxes", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.tabs?.every((v) => ALL_VIEWS.includes(v))).toBe(true);
      expect(t.tabs).toContain("home");
      expect(parseTemplate(templateCode(t))?.boxes).toHaveLength(t.boxes.length);
    }
  });

  it("shares a template as a code and reads it back, notes and all", () => {
    const l = recommendedLayout();
    l.boxes[1] = { ...l.boxes[1]!, title: "Åtgärder 🚀", text: "Ring banken" };
    const mine = templateFrom(l, "Min vecka", "Allt jag behöver");
    const code = templateCode(mine);
    expect(code.startsWith("devledger-template:")).toBe(true);
    const back = parseTemplate(code)!;
    expect(back.name).toBe("Min vecka");
    expect(back.description).toBe("Allt jag behöver");
    expect(back.boxes[1]).toMatchObject({ title: "Åtgärder 🚀", text: "Ring banken" });
    expect(back.id).not.toBe(mine.id);
  });

  it("refuses text that is not a template code", () => {
    expect(parseTemplate("hello")).toBeNull();
    expect(parseTemplate("devledger-template:%%%")).toBeNull();
    expect(parseTemplate(`devledger-template:${btoa(JSON.stringify({ boxes: [] }))}`)).toBeNull();
  });

  it("moves an item and clamps at the ends", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], 2, -2)).toEqual(["c", "a", "b"]);
  });
});
