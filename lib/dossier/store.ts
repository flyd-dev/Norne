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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Read the stored dossier, or null if none has been generated yet. */
export async function readDossier(): Promise<Dossier | null> {
  try {
    const raw = await readFile(dossierPath(), "utf8");
    const parsed = JSON.parse(raw) as Dossier;
    if (!parsed || typeof parsed.text !== "string") return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Persist the dossier (atomic write). */
export async function writeDossier(dossier: Dossier): Promise<void> {
  const path = dossierPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(dossier, null, 2), "utf8");
  await rename(tmp, path);
}
