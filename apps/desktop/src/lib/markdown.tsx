// A small Markdown renderer for the assistant's answers.
//
// It builds React elements and never sets HTML, so nothing in an answer can
// run as markup. It covers what the assistant is asked to write -- headings,
// bullets, numbered lists, bold, italics, inline code and short code blocks --
// and shows anything else as plain text.

import { Fragment, type ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    const k = `${key}-${i++}`;
    if (token.startsWith("**")) out.push(<strong key={k}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else out.push(<em key={k}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith("```"); i++) body.push(lines[i]!);
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (!trimmed) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "h", level: heading[1]!.length, text: heading[2]! });
    } else if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const text = (bullet ?? numbered)![1]!;
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === kind) prev.items.push(text);
      else blocks.push({ kind, items: [text] });
    } else if (/^\s{2,}\S/.test(line) && blocks.length && (blocks[blocks.length - 1]!.kind === "ul" || blocks[blocks.length - 1]!.kind === "ol") && !para.length) {
      // A continuation line indented under a list item.
      const list = blocks[blocks.length - 1] as { items: string[] };
      list.items[list.items.length - 1] += ` ${trimmed}`;
    } else {
      para.push(trimmed);
    }
  }
  flush();
  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      {parseBlocks(source).map((b, i) => {
        const k = String(i);
        switch (b.kind) {
          case "h":
            return b.level <= 2 ? <h3 key={k}>{inline(b.text, k)}</h3> : <h4 key={k}>{inline(b.text, k)}</h4>;
          case "p":
            return <p key={k}>{inline(b.text, k)}</p>;
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={k}>
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item, `${k}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={k}>
                <code>{b.text}</code>
              </pre>
            );
          default:
            return <Fragment key={k} />;
        }
      })}
    </div>
  );
}
