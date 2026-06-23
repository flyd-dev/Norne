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
  folderDeltaPage,
  listDrives,
  resolveFolderId,
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

/** Why a file was skipped — surfaced so the operator can judge if OCR is worth it. */
export type SkipReason = "unsupported" | "too_large" | "no_text" | "error";

type ItemResult =
  | { outcome: "indexed" | "removed" | "folder" }
  | { outcome: "skipped"; reason: SkipReason };

/** Log a skipped file (name + reason) so the operator can review the skips. */
function logSkip(name: string, reason: SkipReason): void {
  console.log(
    JSON.stringify({ evt: "sharepoint_skipped", reason, name }),
  );
}

async function processItem(
  driveId: string,
  item: GraphDriveItem,
  maxBytes: number,
): Promise<ItemResult> {
  const documentId = docIdFor(driveId, item.id);

  // Tombstone: the item was deleted/moved out — drop it from both stores.
  if (item.deleted) {
    await deleteDocument(documentId).catch(() => undefined);
    removeDocumentFromIndex(documentId);
    return { outcome: "removed" };
  }
  // Delta is a flat recursive feed; folders carry no content.
  if (item.folder || !item.file) return { outcome: "folder" };

  const name = item.name ?? "";
  try {
    fileTypeFromName(name);
  } catch {
    logSkip(name, "unsupported");
    return { outcome: "skipped", reason: "unsupported" }; // e.g. image, pptx, zip
  }
  if (typeof item.size === "number" && item.size > maxBytes) {
    logSkip(name, "too_large");
    return { outcome: "skipped", reason: "too_large" };
  }

  const buffer = await downloadItem(driveId, item.id);
  const uploadedAt = item.lastModifiedDateTime ?? new Date().toISOString();
  try {
    const content = await extractText(buffer, name);
    const chunks = buildChunks(content, {
      documentId,
      documentName: name,
      uploadedAt,
    });
    if (chunks.length === 0) {
      // Parsed but yielded no text — typically a scanned PDF/image: OCR candidate.
      logSkip(name, "no_text");
      return { outcome: "skipped", reason: "no_text" };
    }
    await saveDocument(
      { id: documentId, name, fileType: content.fileType, uploadedAt },
      chunks,
      content.structured,
    );
    await indexDocumentChunks(documentId, chunks);
    return { outcome: "indexed" };
  } catch (error) {
    if (
      error instanceof ExtractionError ||
      error instanceof UnsupportedFileTypeError
    ) {
      // No extractable text (e.g. scanned PDF with no text layer) — OCR candidate.
      logSkip(name, "no_text");
      return { outcome: "skipped", reason: "no_text" };
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

  // A "source" is a delta feed to walk: either a whole drive, or a single folder
  // within a drive. Each carries its own cursor key in state.cursors.
  const folderPath = env.sharepoint.folder();
  const sources: {
    driveId: string;
    cursorKey: string;
    fetch: (
      link?: string,
    ) => Promise<{ items: GraphDriveItem[]; nextLink?: string; deltaLink?: string }>;
  }[] = [];

  if (folderPath) {
    // Folder mode: find the drive(s) that actually contain the folder and scope
    // the delta to it — nothing outside the folder is ever enumerated.
    for (const drive of drives) {
      const folderId = await resolveFolderId(drive.id, folderPath);
      if (folderId) {
        sources.push({
          driveId: drive.id,
          cursorKey: `${drive.id}:${folderId}`,
          fetch: (link) => folderDeltaPage(drive.id, folderId, link),
        });
      }
    }
    if (sources.length === 0) {
      throw new Error(
        `SharePoint folder "${folderPath}" was not found in any synced library ` +
          `on the site. Check SHAREPOINT_FOLDER (and SHAREPOINT_DRIVES).`,
      );
    }
  } else {
    for (const drive of drives) {
      sources.push({
        driveId: drive.id,
        cursorKey: drive.id,
        fetch: (link) => deltaPage(drive.id, link),
      });
    }
  }

  let indexed = 0;
  let removed = 0;
  let skipped = 0;
  const skippedReasons: Record<SkipReason, number> = {
    unsupported: 0,
    too_large: 0,
    no_text: 0,
    error: 0,
  };
  let morePending = false;

  for (const source of sources) {
    let link: string | undefined = state.cursors[source.cursorKey];
    // Page through this source until the budget runs out or we reach its
    // deltaLink (source complete for now).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (budget <= 0) {
        morePending = true;
        break;
      }
      const page = await source.fetch(link);
      for (const item of page.items) {
        if (budget <= 0) {
          morePending = true;
          break;
        }
        try {
          const result = await processItem(source.driveId, item, maxBytes);
          if (result.outcome === "indexed") indexed++;
          else if (result.outcome === "removed") removed++;
          else if (result.outcome === "skipped") {
            skipped++;
            skippedReasons[result.reason]++;
          }
          if (result.outcome !== "folder") budget--;
        } catch (error) {
          skipped++;
          skippedReasons.error++;
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
        state.cursors[source.cursorKey] = page.nextLink; // resume mid-enumeration
        await writeSyncState(state);
        if (budget <= 0) {
          morePending = true;
          break;
        }
        continue;
      }
      // No nextLink → deltaLink marks this source complete for now.
      if (page.deltaLink) state.cursors[source.cursorKey] = page.deltaLink;
      await writeSyncState(state);
      break;
    }
    if (budget <= 0) break; // resume remaining sources on the next batch
  }

  await writeSyncState(state);
  return { indexed, removed, skipped, skippedReasons, done: !morePending };
}
