/**
 * Persistence for the SharePoint sync cursor (per-drive delta links).
 *
 * Holds only opaque Graph delta links and the resolved site id; no document
 * contents, no secrets. Backend selected by STORE_BACKEND:
 *   - "local" (default): a single JSON file (SHAREPOINT_STATE_PATH) on the VPS.
 *   - "cloud": a single Firestore document (serverless / Vercel).
 */

import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "@/lib/env";
import type { SyncState } from "@/lib/sharepoint/types";

const SYNC_STATE_DOC_ID = "sharepoint_sync";

function statePath(): string {
  return env.sharepoint.statePath();
}

export async function readSyncState(): Promise<SyncState> {
  if (env.storeBackend() === "cloud") {
    const { readStateDoc } = await import("@/lib/firestore/appStore");
    const state = await readStateDoc<SyncState>(SYNC_STATE_DOC_ID);
    return state ? { siteId: state.siteId, cursors: state.cursors ?? {} } : { cursors: {} };
  }
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
  if (env.storeBackend() === "cloud") {
    const { writeStateDoc } = await import("@/lib/firestore/appStore");
    // Firestore rejects `undefined` fields; only include siteId when set.
    await writeStateDoc(SYNC_STATE_DOC_ID, {
      ...(state.siteId !== undefined ? { siteId: state.siteId } : {}),
      cursors: state.cursors ?? {},
    });
    return;
  }
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}
