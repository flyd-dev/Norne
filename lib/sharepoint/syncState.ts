/**
 * Persistence for the SharePoint sync cursor (per-drive delta links).
 *
 * A single small JSON file (SHAREPOINT_STATE_PATH) — same local-file approach as
 * the document/feedback stores, NOT Firestore. Holds only opaque Graph delta
 * links and the resolved site id; no document contents, no secrets.
 */

import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@/lib/env";
import type { SyncState } from "@/lib/sharepoint/types";

function statePath(): string {
  return env.sharepoint.statePath();
}

export async function readSyncState(): Promise<SyncState> {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    return { siteId: parsed.siteId, cursors: parsed.cursors ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { cursors: {} };
    }
    throw error;
  }
}

export async function writeSyncState(state: SyncState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}
