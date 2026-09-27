// A small Markdown renderer for the finished file: headings, paragraphs, lists
// (nested by indent), task boxes, quotes, code fences, tables, rules, and inline
// code / bold / italic / strike / links. It builds React elements and never
// injects HTML, so a file can't run script or style the page. Links are limited
// to http(s) and mailto.
import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; head: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] }
  | { kind: "rule" };
type ListItem = { text: string; checked: boolean | null; children: Block[] };

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Split a table row into cells (a leading/trailing pipe is optional; \| is a literal pipe). */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function indentOf(line: string): number {
  const spaces = /^\s*/.exec(line)![0];
  return spaces.replace(/\t/g, "    ").length;
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of file)
      blocks.push({ kind: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", head, align, rows });
      continue;
    }
    if (BULLET.test(line)) {
      const [list, next] = parseList(lines, i, indentOf(line));
      blocks.push(list);
      i = next;
      continue;
    }
    // Paragraph: until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !/^\s{0,3}>/.test(lines[i]) &&
      !BULLET.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    blocks.push({ kind: "para", text: para.join("\n") });
  }
  return blocks;
}

/** A list starting at `start` whose items sit at `indent`; deeper lines become nested blocks. */
function parseList(lines: string[], start: number, indent: number): [Block, number] {
  const first = BULLET.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const list: Block & { kind: "list" } = { kind: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && indentOf(next) >= indent && (BULLET.test(next) || indentOf(next) > indent)) {
        i++;
        continue;
      }
      break;
    }
    const bullet = BULLET.exec(line);
    const depth = indentOf(line);
    if (bullet && depth === indent && /\d/.test(bullet[2]) === ordered) {
      let text = bullet[3];
      let checked: boolean | null = null;
      const box = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (box) {
        checked = box[1] !== " ";
        text = box[2];
      }
      list.items.push({ text, checked, children: [] });
      i++;
      continue;
    }
    if (depth > indent && list.items.length) {
      const item = list.items[list.items.length - 1];
      if (bullet) {
        const [child, next] = parseList(lines, i, depth);
        item.children.push(child);
        i = next;
      } else {
        item.text += "\n" + line.trim(); // a wrapped line of the same item
        i++;
      }
      continue;
    }
    break;
  }
  return [list, i];
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline Markdown: `code`, **bold**, *italic*, ~~strike~~, [links](url) and bare URLs. */
export function inline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern =
    /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][\s\S]*?)\*|(?<![\w])_([^_\s][\s\S]*?)_(?![\w])|~~([\s\S]+?)~~|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\n/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${n++}`;
    if (m[1]) out.push(<code key={key}>{m[2].trim()}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={key}>{inline(m[3] ?? m[4], key)}</strong>);
    else if (m[5] ?? m[6]) out.push(<em key={key}>{inline(m[5] ?? m[6], key)}</em>);
    else if (m[7]) out.push(<del key={key}>{inline(m[7], key)}</del>);
    else if (m[8]) {
      out.push(
        SAFE_URL.test(m[9]) ? (
          <a key={key} href={m[9]} target="_blank" rel="noopener noreferrer">
            {inline(m[8], key)}
          </a>
        ) : (
          <span key={key}>{inline(m[8], key)}</span>
        ),
      );
    } else if (m[10]) {
      out.push(
        <a key={key} href={m[10]} target="_blank" rel="noopener noreferrer">
          {m[10]}
        </a>,
      );
    } else out.push(<br key={key} />);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case "heading": {
      const H = `h${Math.min(block.level + 1, 6)}` as "h2"; // the panel title is the h1
      return <H key={key}>{inline(block.text, key)}</H>;
    }
    case "para":
      return <p key={key}>{inline(block.text, key)}</p>;
    case "code":
      return (
        <pre key={key} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{parseBlocks(block.lines.join("\n")).map((b, i) => renderBlock(b, `${key}-${i}`))}</blockquote>;
    case "rule":
      return <hr key={key} />;
    case "table":
      return (
        <div className="md-table" key={key}>
          <table>
            <thead>
              <tr>{block.head.map((c, i) => <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>{inline(c, `${key}-h${i}`)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {block.head.map((_, i) => <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>{inline(row[i] ?? "", `${key}-${r}-${i}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : "md-task"}>
          {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} aria-label={item.checked ? "done" : "not done"} />}
          {inline(item.text, `${key}-${i}`)}
          {item.children.map((child, c) => renderBlock(child, `${key}-${i}-${c}`))}
        </li>
      ));
      return block.ordered ? <ol key={key} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
  }
}

export function Markdown({ source }: { source: string }) {
  return <>{parseBlocks(source).map((block, i) => renderBlock(block, `b${i}`))}</>;
}

/** Files shown formatted; anything else (code, JSON, CSV, HTML...) is shown as plain text. */
export function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown|txt)$/i.test(filename) || !/\.[a-z0-9]+$/i.test(filename);
}
