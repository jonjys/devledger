import { render } from "@testing-library/react";

import { Markdown, parseBlocks } from "./markdown";

describe("assistant markdown", () => {
  it("reads headings, lists and paragraphs", () => {
    const blocks = parseBlocks("## Do this first\n1. Roll the key\n2. Update Vercel\n\nThen **check** logs.\n- a\n- b");
    expect(blocks.map((b) => b.kind)).toEqual(["h", "ol", "p", "ul"]);
  });

  it("never renders markup from the answer", () => {
    const { container } = render(<Markdown source={'<img src=x onerror="alert(1)"> **bold** `code`'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
