import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFeedback, listFeedback } from "@/lib/feedback/store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "norne-fb-"));
  process.env.DOCUMENT_FEEDBACK_PATH = join(dir, "feedback.json");
});

afterEach(async () => {
  delete process.env.DOCUMENT_FEEDBACK_PATH;
  await rm(dir, { recursive: true, force: true });
});

const ALLOWED_KEYS = [
  "timestamp",
  "rating",
  "question",
  "answer",
  "sources",
  "route",
  "correction",
].sort();

describe("appendFeedback", () => {
  it("stores a sanitised record with only the allowed fields", async () => {
    await appendFeedback({
      rating: "bad",
      question: "Hva fører jeg arbeidshansker på?",
      answer: "Konto 6570.",
      sources: ["accounts", "kontoplan.xlsx"],
      route: "account_lookup",
      correction: "Skulle vært konto 6570 med forklaring.",
    });

    const raw = await readFile(process.env.DOCUMENT_FEEDBACK_PATH!, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.feedback).toHaveLength(1);
    const rec = parsed.feedback[0];
    expect(Object.keys(rec).sort()).toEqual(ALLOWED_KEYS);
    expect(rec.rating).toBe("bad");
    expect(rec.route).toBe("account_lookup");
    expect(rec.sources).toEqual(["accounts", "kontoplan.xlsx"]);
    expect(typeof rec.timestamp).toBe("string");
  });

  it("does not persist any chat history or extra/secret fields", async () => {
    // The store API only accepts the fields above; anything else is dropped.
    // Cast through unknown to simulate a caller smuggling in extra fields.
    const payload = {
      rating: "good",
      question: "Q",
      answer: "A",
      sources: [],
      route: null,
      correction: null,
      history: [{ role: "user", content: "SECRET-HISTORY" }],
      apiKey: "sk-SECRET",
    } as unknown as Parameters<typeof appendFeedback>[0];
    await appendFeedback(payload);

    const raw = await readFile(process.env.DOCUMENT_FEEDBACK_PATH!, "utf8");
    expect(raw).not.toContain("SECRET-HISTORY");
    expect(raw).not.toContain("sk-SECRET");
    expect(raw).not.toContain("history");
    expect(raw).not.toContain("apiKey");
  });

  it("caps long correction text and the number of sources", async () => {
    await appendFeedback({
      rating: "bad",
      question: "Q",
      answer: "A",
      sources: Array.from({ length: 100 }, (_, i) => `src${i}`),
      route: null,
      correction: "x".repeat(10000),
    });
    const [rec] = await listFeedback();
    expect(rec.correction!.length).toBeLessThanOrEqual(4000);
    expect(rec.sources.length).toBeLessThanOrEqual(50);
  });
});

describe("listFeedback", () => {
  it("returns records newest first", async () => {
    await appendFeedback({
      rating: "good",
      question: "first",
      answer: "A",
      sources: [],
      route: null,
      correction: null,
    });
    // Ensure a later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await appendFeedback({
      rating: "bad",
      question: "second",
      answer: "A",
      sources: [],
      route: null,
      correction: null,
    });
    const all = await listFeedback();
    expect(all).toHaveLength(2);
    expect(all[0].question).toBe("second");
  });
});
