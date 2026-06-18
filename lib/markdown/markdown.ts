/**
 * Tiny, safe Markdown parser for assistant answers.
 *
 * The model returns lightweight Markdown — **bold**, `code`, `#`/`##`/`###`
 * headings, `-`/`*` bullet lists, `1.` numbered lists, fenced ``` code blocks
 * and blank-line paragraphs. Rendering it as raw text leaks the markers (`**`,
 * `###`) to the user; this module turns the text into a plain data tree the
 * chat component renders with real React elements.
 *
 * Why a parser to data (not HTML): the chat UI renders the returned nodes as
 * React elements (<strong>, <ul>, <h3>, …), so there is never any HTML string
 * to inject — no `dangerouslySetInnerHTML`, no sanitisation gap, nothing the
 * model can smuggle through. Anything we don't recognise stays literal text.
 *
 * Pure and dependency-free for easy testing — tests assert on the data tree,
 * not on rendered markup.
 */

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "code"; value: string };

export type Block =
  | { type: "heading"; level: number; inline: InlineNode[] }
  | { type: "paragraph"; lines: InlineNode[][] }
  | { type: "bullets"; items: InlineNode[][] }
  | { type: "ordered"; items: InlineNode[][] }
  | { type: "code"; lang: string | null; code: string };

/**
 * Parse inline markers within a single run of text. Recognises (in priority
 * order) inline `code`, **bold** / __bold__, and *emphasis*. Unmatched markers
 * (e.g. a lone `*`) are kept verbatim, so normal prose is never mangled.
 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push({ type: "text", value: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Inline code: `…` — wins over emphasis so `**` inside code stays literal.
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        nodes.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Bold: **…** or __…__
    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      const marker = text.slice(i, i + 2);
      const end = text.indexOf(marker, i + 2);
      if (end > i + 1) {
        flush();
        nodes.push({
          type: "strong",
          children: parseInline(text.slice(i + 2, end)),
        });
        i = end + 2;
        continue;
      }
    }

    // Emphasis: *…* (single asterisk; bold was already handled above).
    if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        flush();
        nodes.push({ type: "em", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return nodes;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const FENCE_RE = /^\s*```(.*)$/;

/**
 * Parse an assistant answer into block-level nodes. Blank lines separate
 * paragraphs; consecutive bullet / numbered lines group into one list; fenced
 * ``` blocks are kept verbatim (no inline parsing inside code).
 */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];

  let para: InlineNode[][] = [];
  let bullets: InlineNode[][] = [];
  let ordered: InlineNode[][] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", lines: para });
      para = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push({ type: "bullets", items: bullets });
      bullets = [];
    }
  };
  const flushOrdered = () => {
    if (ordered.length) {
      blocks.push({ type: "ordered", items: ordered });
      ordered = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushBullets();
    flushOrdered();
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];

    // Fenced code block: capture everything up to the closing fence verbatim.
    const fence = raw.match(FENCE_RE);
    if (fence) {
      flushAll();
      const lang = fence[1].trim() || null;
      const code: string[] = [];
      idx++;
      while (idx < lines.length && !FENCE_RE.test(lines[idx])) {
        code.push(lines[idx]);
        idx++;
      }
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue; // idx now points at the closing fence (or end); loop advances past it.
    }

    const line = raw.trimEnd();
    const heading = line.match(HEADING_RE);
    const bullet = line.match(BULLET_RE);
    const orderedLine = line.match(ORDERED_RE);

    if (heading) {
      flushAll();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inline: parseInline(heading[2].trim()),
      });
    } else if (bullet) {
      flushPara();
      flushOrdered();
      bullets.push(parseInline(bullet[1]));
    } else if (orderedLine) {
      flushPara();
      flushBullets();
      ordered.push(parseInline(orderedLine[1]));
    } else if (line.trim() === "") {
      flushAll();
    } else {
      flushBullets();
      flushOrdered();
      para.push(parseInline(line));
    }
  }

  flushAll();
  return blocks;
}
