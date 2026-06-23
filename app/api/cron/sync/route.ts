/**
 * GET /api/cron/sync — nightly knowledge-base refresh, for Vercel Cron.
 *
 * The serverless equivalent of scripts/nightly-update.sh: drives the SharePoint
 * delta sync to completion (looping bounded batches within a time budget so it
 * stays under the function's maxDuration), then regenerates the case dossier
 * when documents actually changed. Resumable: if the time budget is hit before
 * the sync is done, the next night's run continues from the delta cursor.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET
 * is configured. The route rejects anything else, so it can't be triggered by
 * the public. Scheduled in vercel.json.
 */

import { NextResponse } from "next/server";
import { env, sharepointReady } from "@/lib/env";
import { syncBatch } from "@/lib/sharepoint/sync";
import { generateDossier } from "@/lib/dossier/generate";
import { errorTypeOf, logAdminError, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Stop STARTING new batches past this elapsed time, leaving room to finish +
 * regenerate the dossier within maxDuration (300s). */
const SYNC_TIME_BUDGET_MS = 220_000;
/** Files per batch — bounded so a single batch comfortably fits the budget. */
const BATCH_MAX_FILES = 50;

export async function GET(request: Request) {
  const secret = env.cron.secret();
  if (!secret) {
    return NextResponse.json(
      { error: "Cron route is disabled (CRON_SECRET not set)." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!sharepointReady()) {
    return NextResponse.json(
      { error: "SharePoint sync is not configured." },
      { status: 503 },
    );
  }

  const requestId = newRequestId();
  const started = Date.now();
  let indexed = 0;
  let removed = 0;
  let skipped = 0;
  let batches = 0;
  let done = false;

  try {
    do {
      const result = await syncBatch({ maxFiles: BATCH_MAX_FILES });
      indexed += result.indexed;
      removed += result.removed;
      skipped += result.skipped;
      batches++;
      done = result.done;
    } while (!done && Date.now() - started < SYNC_TIME_BUDGET_MS);

    // Regenerate the dossier only when the sync changed the corpus — no point
    // spending an LLM call when nothing was indexed or removed.
    let dossierRegenerated = false;
    if (done && (indexed > 0 || removed > 0)) {
      const dossier = await generateDossier();
      dossierRegenerated = dossier !== null;
    }

    return NextResponse.json(
      {
        ok: true,
        done,
        batches,
        indexed,
        removed,
        skipped,
        dossierRegenerated,
        elapsedMs: Date.now() - started,
      },
      { status: 200 },
    );
  } catch (error) {
    logAdminError(requestId, "cron_sync", error);
    return NextResponse.json(
      { error: "Cron sync failed.", errorType: errorTypeOf(error), requestId },
      { status: 500 },
    );
  }
}
