import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "@/lib/markdown/markdown";

/** Concatenate the literal text in an inline tree (for "no raw markers" checks). */
function inlineText(nodes: ReturnType<typeof parseInline>): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "code":
          return n.value;
        case "strong":
        case "em":
          return inlineText(n.children);
      }
    })
    .join("");
}

describe("parseInline", () => {
  it("parses **bold** as a strong node, not raw asterisks", () => {
    const nodes = parseInline("Tilgjengelig **kapasitet** nå");
    const strong = nodes.find((n) => n.type === "strong");
    expect(strong).toBeDefined();
    // The asterisks are consumed — no literal ** remains anywhere.
    expect(inlineText(nodes)).toBe("Tilgjengelig kapasitet nå");
    expect(inlineText(nodes)).not.toContain("*");
  });

  it("parses __bold__ and *emphasis*", () => {
    expect(parseInline("__sterk__").some((n) => n.type === "strong")).toBe(true);
    expect(parseInline("litt *vekt* her").some((n) => n.type === "em")).toBe(true);
  });

  it("parses inline `code` and keeps markers inside code literal", () => {
    const nodes = parseInline("bruk `**ikke bold**` her");
    const code = nodes.find((n) => n.type === "code");
    expect(code).toBeDefined();
    expect(code && code.type === "code" ? code.value : "").toBe("**ikke bold**");
  });

  it("leaves an unmatched marker as literal text", () => {
    const nodes = parseInline("2 * 3 = 6");
    expect(inlineText(nodes)).toBe("2 * 3 = 6");
  });
});

describe("parseBlocks", () => {
  it("parses ### headings without leaking the hashes", () => {
    const blocks = parseBlocks("### Tilgjengelig kapasitet\nWelder: 2 900 timer");
    const heading = blocks.find((b) => b.type === "heading");
    expect(heading && heading.type === "heading" ? heading.level : 0).toBe(3);
    expect(heading && heading.type === "heading" ? inlineText(heading.inline) : "").toBe(
      "Tilgjengelig kapasitet",
    );
    // The raw "###" must not survive in any rendered text.
    const allText = blocks
      .map((b) =>
        b.type === "heading"
          ? inlineText(b.inline)
          : b.type === "paragraph"
            ? b.lines.map(inlineText).join(" ")
            : "",
      )
      .join(" ");
    expect(allText).not.toContain("#");
  });

  it("groups bullet and numbered lists", () => {
    const bullets = parseBlocks("- en\n- to\n- tre");
    expect(bullets[0].type).toBe("bullets");
    expect(bullets[0].type === "bullets" ? bullets[0].items.length : 0).toBe(3);

    const ordered = parseBlocks("1. først\n2. så");
    expect(ordered[0].type).toBe("ordered");
    expect(ordered[0].type === "ordered" ? ordered[0].items.length : 0).toBe(2);
  });

  it("keeps soft line breaks inside a paragraph and bold within it", () => {
    const blocks = parseBlocks("Linje en med **vekt**\nLinje to");
    const para = blocks.find((b) => b.type === "paragraph");
    expect(para && para.type === "paragraph" ? para.lines.length : 0).toBe(2);
    const first = para && para.type === "paragraph" ? para.lines[0] : [];
    expect(first.some((n) => n.type === "strong")).toBe(true);
  });

  it("captures fenced code blocks verbatim", () => {
    const blocks = parseBlocks("Tekst\n```\nlinje 1\nlinje 2\n```\nMer tekst");
    const code = blocks.find((b) => b.type === "code");
    expect(code && code.type === "code" ? code.code : "").toBe("linje 1\nlinje 2");
  });

  it("does not treat a **bold** line start as a bullet", () => {
    const blocks = parseBlocks("**Tilgjengelig kapasitet**");
    expect(blocks[0].type).toBe("paragraph");
  });
});
