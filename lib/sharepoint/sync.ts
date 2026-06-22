/**
 * SharePoint → knowledge-base sync orchestration.
 *
 * Walks the configured site's document libraries via the Graph delta feed,
 * extracts text from each supported file, and indexes it into BOTH the JSON
 * store (keyword + structured) and the sqlite-vec store (semantic) — exactly the
 * same pipeline as an admin upload, so synced docs answer like uploaded ones.
 *
 * Resumable + incremental by design: each call processes a bounded batch of
 * files and persists per-drive delta cursors. Run it repeatedly to load a large
 * library over several batches; once every drive reaches its deltaLink, later
 * runs return only what changed. A per-file failure is skipped (logged by type),
 * never aborting the batch.
 *
 * Server-side only.
 */

import "server-only";
import { sharepointReady, env } from "@/lib/env";
import { extractText, fileTypeFromName } from "@/lib/documents/extract";
import { buildChunks } from "@/lib/documents/chunk";
import { deleteDocument, saveDocument } from "@/lib/documents/store";
import { ExtractionError, UnsupportedFileTypeError } from "@/lib/documents/types";
import { indexDocumentChunks, removeDocumentFromIndex } from "@/lib/rag/indexDocument";
import {
  deltaPage,
  downloadItem,
  listDrives,
  resolveSiteId,
} from "@/lib/sharepoint/graphClient";
import { readSyncState, writeSyncState } from "@/lib/sharepoint/syncState";
import type { GraphDriveItem, SyncBatchResult } from "@/lib/sharepoint/types";
import { errorTypeOf } from "@/lib/logger";

/** Default files processed per batch (keeps a single call bounded). */
const DEFAULT_MAX_FILES = 50;

/** Stable knowledge-base id for a SharePoint item (so re-sync replaces it). */
function docIdFor(driveId: string, itemId: string): string {
  return `sp:${driveId}:${itemId}`;
}

type ItemOutcome = "indexed" | "removed" | "skipped" | "folder";

async function processItem(
  driveId: string,
  item: GraphDriveItem,
  maxBytes: number,
): Promise<ItemOutcome> {
  const documentId = docIdFor(driveId, item.id);

  // Tombstone: the item was deleted/moved out — drop it from both stores.
  if (item.deleted) {
    await deleteDocument(documentId).catch(() => undefined);
    removeDocumentFromIndex(documentId);
    return "removed";
  }
  // Delta is a flat recursive feed; folders carry no content.
  if (item.folder || !item.file) return "folder";

  const name = item.name ?? "";
  let fileType;
  try {
    fileType = fileTypeFromName(name);
  } catch {
    return "skipped"; // unsupported extension
  }
  if (typeof item.size === "number" && item.size > maxBytes) return "skipped";

  const buffer = await downloadItem(driveId, item.id);
  const uploadedAt = item.lastModifiedDateTime ?? new Date().toISOString();
  try {
    const content = await extractText(buffer, name);
    const chunks = buildChunks(content, {
      documentId,
      documentName: name,
      uploadedAt,
    });
    if (chunks.length === 0) return "skipped";
    await saveDocument(
      { id: documentId, name, fileType: content.fileType, uploadedAt },
      chunks,
      content.structured,
    );
    await indexDocumentChunks(documentId, chunks);
    return "indexed";
  } catch (error) {
    if (
      error instanceof ExtractionError ||
      error instanceof UnsupportedFileTypeError
    ) {
      return "skipped"; // unreadable file — skip, don't abort the batch
    }
    throw error;
  }
}

/**
 * Run one bounded sync batch. Returns counts and `done: true` once every drive
 * has been fully enumerated (steady-state incremental sync).
 */
export async function syncBatch(
  opts: { maxFiles?: number } = {},
): Promise<SyncBatchResult> {
  if (!sharepointReady()) {
    throw new Error(
      "SharePoint sync is not configured (set SHAREPOINT_ENABLED=true and the " +
        "SHAREPOINT_* credentials).",
    );
  }
  let budget = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = env.sharepoint.maxFileMb() * 1024 * 1024;
  const onlyDrives = env.sharepoint.driveNames();

  const state = await readSyncState();
  if (!state.siteId) state.siteId = await resolveSiteId();

  let drives = await listDrives(state.siteId);
  if (onlyDrives.length > 0) {
    drives = drives.filter((d) => onlyDrives.includes(d.name));
  }

  let indexed = 0;
  let removed = 0;
  let skipped = 0;
  let morePending = false;

  for (const drive of drives) {
    let link: string | undefined = state.cursors[drive.id];
    // Page through this drive until the budget runs out or we reach its
    // deltaLink (drive complete for now).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (budget <= 0) {
        morePending = true;
        break;
      }
      const page = await deltaPage(drive.id, link);
      for (const item of page.items) {
        if (budget <= 0) {
          morePending = true;
          break;
        }
        try {
          const outcome = await processItem(drive.id, item, maxBytes);
          if (outcome === "indexed") indexed++;
          else if (outcome === "removed") removed++;
          else if (outcome === "skipped") skipped++;
          if (outcome !== "folder") budget--;
        } catch (error) {
          skipped++;
          budget--;
          console.error(
            JSON.stringify({
              evt: "sharepoint_item_failed",
              errorType: errorTypeOf(error),
            }),
          );
        }
      }

      if (page.nextLink) {
        link = page.nextLink;
        state.cursors[drive.id] = page.nextLink; // resume mid-enumeration
        await writeSyncState(state);
        if (budget <= 0) {
          morePending = true;
          break;
        }
        continue;
      }
      // No nextLink → deltaLink marks this drive complete for now.
      if (page.deltaLink) state.cursors[drive.id] = page.deltaLink;
      await writeSyncState(state);
      break;
    }
    if (budget <= 0) break; // resume remaining drives on the next batch
  }

  await writeSyncState(state);
  return { indexed, removed, skipped, done: !morePending };
}
