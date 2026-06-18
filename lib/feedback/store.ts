/**
 * Local filesystem persistence for answer feedback.
 *
 * When a user rates an answer ("Bra svar" / "Dårlig svar", optionally with a
 * correction), we append a sanitised record to a single JSON file on the server
 * (DOCUMENT_FEEDBACK_PATH, default /var/lib/norne-chatbot/feedback.json).
 *
 * Privacy rules (enforced here, not trusted from the caller):
 *   - NEVER store secrets/tokens.
 *   - NEVER store full chat history.
 *   - NEVER store uploaded document contents — only short source labels.
 * All free-text fields are length-capped as a precaution.
 */

import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@/lib/env";

export type FeedbackRating = "good" | "bad";

export interface FeedbackInput {
  rating: FeedbackRating;
  /** The user's question. */
  question: string;
  /** The assistant answer the user is rating. */
  answer: string;
  /** Short source labels shown to the user (collection paths / document names). */
  sources: string[];
  /** Route/intent the answer used, if known. */
  route: string | null;
  /** What the answer should have been (only for "bad"); optional. */
  correction: string | null;
}

export interface FeedbackRecord extends FeedbackInput {
  timestamp: string;
}

interface FeedbackFile {
  feedback: FeedbackRecord[];
}

/** Caps to keep the file bounded and avoid storing large blobs of text. */
const MAX_TEXT = 4000;
const MAX_CORRECTION = 4000;
const MAX_SOURCES = 50;
const MAX_SOURCE_LEN = 200;

function storePath(): string {
  return env.feedback.storePath();
}

function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Strip a record down to allowed, length-capped fields. */
function sanitize(input: FeedbackInput): FeedbackRecord {
  return {
    timestamp: new Date().toISOString(),
    rating: input.rating,
    question: clamp(input.question, MAX_TEXT),
    answer: clamp(input.answer, MAX_TEXT),
    sources: (input.sources ?? [])
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .slice(0, MAX_SOURCES)
      .map((s) => clamp(s, MAX_SOURCE_LEN)),
    route: input.route ? clamp(input.route, 64) : null,
    correction:
      input.correction && input.correction.trim().length > 0
        ? clamp(input.correction, MAX_CORRECTION)
        : null,
  };
}

async function readFeedbackFile(): Promise<FeedbackFile> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as FeedbackFile;
    if (!parsed || !Array.isArray(parsed.feedback)) return { feedback: [] };
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { feedback: [] };
    }
    throw error;
  }
}

async function writeFeedbackFile(file: FeedbackFile): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  await rename(tmp, path);
}

// Serialize read-modify-write operations to avoid clobbering on concurrent posts.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** True for filesystem permission/read-only errors (clear admin messaging). */
export function isFilesystemPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/** Append one sanitised feedback record. Returns the stored record. */
export async function appendFeedback(
  input: FeedbackInput,
): Promise<FeedbackRecord> {
  const record = sanitize(input);
  await withLock(async () => {
    const file = await readFeedbackFile();
    file.feedback.push(record);
    await writeFeedbackFile(file);
  });
  return record;
}

/** List all feedback records, newest first. */
export async function listFeedback(): Promise<FeedbackRecord[]> {
  const file = await readFeedbackFile();
  return [...file.feedback].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
}
