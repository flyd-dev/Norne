#!/usr/bin/env node
/**
 * Turso connectivity + vector-SQL smoke test.
 *
 * Confirms the managed libSQL database is reachable and that the exact vector
 * dialect the app uses (F32_BLOB, vector32(), vector_distance_cos()) works —
 * BEFORE wiring the cloud backend into the app. Creates a throwaway table and
 * drops it; touches nothing the app uses.
 *
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/smoke-turso.mjs
 */

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error("Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN).");
  process.exit(1);
}

const c = createClient({ url, ...(authToken ? { authToken } : {}) });

try {
  await c.execute("DROP TABLE IF EXISTS _norne_smoke");
  await c.execute(
    "CREATE TABLE _norne_smoke (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, v F32_BLOB(3))",
  );
  await c.batch(
    [
      { sql: "INSERT INTO _norne_smoke(label, v) VALUES ('x', vector32(?))", args: [JSON.stringify([1, 0, 0])] },
      { sql: "INSERT INTO _norne_smoke(label, v) VALUES ('y', vector32(?))", args: [JSON.stringify([0, 1, 0])] },
      { sql: "INSERT INTO _norne_smoke(label, v) VALUES ('near-x', vector32(?))", args: [JSON.stringify([0.9, 0.1, 0])] },
    ],
    "write",
  );

  const res = await c.execute({
    sql: `SELECT label, vector_distance_cos(v, vector32(?)) AS distance
            FROM _norne_smoke ORDER BY distance ASC`,
    args: [JSON.stringify([1, 0, 0])],
  });

  console.log("KNN result (querying for [1,0,0], nearest first):");
  for (const r of res.rows) {
    console.log(`  ${r.label.padEnd(8)} distance=${Number(r.distance).toFixed(4)}  similarity=${(1 - Number(r.distance)).toFixed(4)}`);
  }

  const order = res.rows.map((r) => r.label).join(",");
  const ok = order === "x,near-x,y";
  console.log(`\nExpected order: x,near-x,y`);
  console.log(`Got order:      ${order}`);
  console.log(ok ? "\n✅ Turso vector search works." : "\n❌ Unexpected order — vector SQL needs a look.");

  await c.execute("DROP TABLE IF EXISTS _norne_smoke");
  process.exit(ok ? 0 : 2);
} catch (error) {
  console.error("\n❌ Turso smoke test failed:", error?.message ?? error);
  await c.execute("DROP TABLE IF EXISTS _norne_smoke").catch(() => {});
  process.exit(1);
}
