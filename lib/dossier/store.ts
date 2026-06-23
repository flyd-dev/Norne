/**
 * Local persistence for the generated case dossier.
 *
 * The dossier is a single structured overview of the whole case, synthesised
 * across all indexed documents. It is stored as one small JSON file (DOSSIER_PATH)
 * — same local-file approach as the document/feedback stores, NOT Firestore — and
 * injected into the chat context on case/overview questions.
 *
 * Server-side only.
 */

import "server-only";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@/lib/env";

export interface Dossier {
  /** ISO timestamp of when the dossier was generated. */
  generatedAt: string;
  /** Number of documents the dossier was synthesised from. */
  documentCount: number;
  /** The dossier text (Markdown), produced by the LLM. */
  text: string;
}

function dossierPath(): string {
  return env.dossier.storePath();
}

/**
 * In-memory cache of the parsed dossier, so the chat path doesn't re-read and
 * re-parse the JSON file on every turn — the dossier is the bot's resident
 * case knowledge and is read on most case questions. Keyed by the file's
 * modification time, so an out-of-process regeneration (admin route / script)
 * is picked up automatically without a server restart, while an unchanged file
 * is served straight from memory (one cheap stat() call, no read/parse).
 */
let cache: { mtimeMs: number; dossier: Dossier | null } | null = null;

/** Read the stored dossier, or null if none has been generated yet. */
export async function readDossier(): Promise<Dossier | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(dossierPath())).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cache = { mtimeMs: 0, dossier: null };
      return null;
    }
    throw error;
  }

  if (cache && cache.mtimeMs === mtimeMs) return cache.dossier;

  try {
    const raw = await readFile(dossierPath(), "utf8");
    const parsed = JSON.parse(raw) as Dossier;
    const dossier =
      parsed && typeof parsed.text === "string" ? parsed : null;
    cache = { mtimeMs, dossier };
    return dossier;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cache = { mtimeMs: 0, dossier: null };
      return null;
    }
    throw error;
  }
}

/** Persist the dossier (atomic write) and refresh the in-memory cache. */
export async function writeDossier(dossier: Dossier): Promise<void> {
  const path = dossierPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(dossier, null, 2), "utf8");
  await rename(tmp, path);
  try {
    cache = { mtimeMs: (await stat(path)).mtimeMs, dossier };
  } catch {
    // If the post-write stat fails, drop the cache so the next read reloads.
    cache = null;
  }
}
