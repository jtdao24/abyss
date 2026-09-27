import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { isMarkdownFile, Markdown, parseBlocks } from "./markdown";

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

describe("parseBlocks", () => {
  it("reads headings, paragraphs, rules, quotes and code fences", () => {
    const blocks = parseBlocks("# Title\n\nSome text\nwrapped.\n\n---\n\n> quoted\n\n```py\nprint(1)\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "para", "rule", "quote", "code"]);
    expect(blocks[1]).toEqual({ kind: "para", text: "Some text\nwrapped." });
    expect(blocks[4]).toEqual({ kind: "code", lang: "py", text: "print(1)" });
  });

  it("nests lists by indent and keeps ordered starts and task boxes", () => {
    const [list] = parseBlocks("3. three\n4. four\n   - sub a\n   - sub b\n5. five");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });
    if (list.kind !== "list") throw new Error("not a list");
    expect(list.items.map((i) => i.text)).toEqual(["three", "four", "five"]);
    expect(list.items[1].children[0]).toMatchObject({ kind: "list", ordered: false });
    const [tasks] = parseBlocks("- [x] done\n- [ ] todo");
    if (tasks.kind !== "list") throw new Error("not a list");
    expect(tasks.items.map((i) => i.checked)).toEqual([true, false]);
  });

  it("reads tables with alignment", () => {
    const [table] = parseBlocks("| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |");
    expect(table).toEqual({ kind: "table", head: ["a", "b"], align: ["left", "right"], rows: [["1", "2"], ["3", "4"]] });
  });

  it("treats an unclosed fence as code to the end", () => {
    expect(parseBlocks("```\nno end")).toEqual([{ kind: "code", lang: "", text: "no end" }]);
  });
});

describe("Markdown", () => {
  it("renders inline styles", () => {
    const out = html("**bold** and *it* and `x < y` and ~~old~~");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>it</em>");
    expect(out).toContain("<code>x &lt; y</code>");
    expect(out).toContain("<del>old</del>");
  });

  it("never renders raw HTML or unsafe links", () => {
    const out = html('<script>alert(1)</script>\n\n[click](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links http(s) safely", () => {
    const out = html("See [docs](https://example.com) or https://abyss.test/x.");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(out).toContain('href="https://abyss.test/x"');
  });

  it("keeps parentheses inside link URLs", () => {
    const out = html("[Fresnel](https://en.wikipedia.org/wiki/Lens_(optics)) and [bad](javascript:alert(1)).");
    expect(out).toContain('href="https://en.wikipedia.org/wiki/Lens_(optics)"');
    expect(out).toContain("<span>bad</span>.");
    expect(out).not.toContain("javascript:");
  });

  it("does not italicise snake_case or arithmetic", () => {
    const out = html("use my_var_name and 2 * 3 * 4");
    expect(out).not.toContain("<em>");
  });
});

describe("isMarkdownFile", () => {
  it("formats markdown and text, shows code and data raw", () => {
    expect(isMarkdownFile("brief.md")).toBe(true);
    expect(isMarkdownFile("notes.txt")).toBe(true);
    expect(isMarkdownFile("README")).toBe(true);
    expect(isMarkdownFile("tool.py")).toBe(false);
    expect(isMarkdownFile("data.json")).toBe(false);
    expect(isMarkdownFile("page.html")).toBe(false);
  });
});
