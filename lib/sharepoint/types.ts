/** Microsoft Graph types (subset) used by the SharePoint sync. */

export interface GraphDrive {
  id: string;
  name: string;
  driveType?: string;
}

/** A drive item from the delta feed (file, folder, or a deleted tombstone). */
export interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  /** Present for files (absent for folders). */
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  /** Present on a delta tombstone for a removed/ moved-out item. */
  deleted?: { state?: string };
  parentReference?: { driveId?: string; path?: string };
  lastModifiedDateTime?: string;
}

/** One page of a Graph delta response. */
export interface GraphDelta {
  value: GraphDriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** Persisted per-drive sync cursor (delta link) keyed by driveId. */
export interface SyncState {
  /** Resolved site id (cached so we don't resolve every run). */
  siteId?: string;
  /** driveId -> the deltaLink to resume from on the next sync. */
  cursors: Record<string, string>;
}

/** Result of a single sync batch. */
export interface SyncBatchResult {
  /** Files extracted + indexed this batch. */
  indexed: number;
  /** Files removed from the index this batch (deleted in SharePoint). */
  removed: number;
  /** Files skipped (unsupported type, too large, or empty). */
  skipped: number;
  /** True when every drive has been fully enumerated (no more nextLinks). */
  done: boolean;
}
