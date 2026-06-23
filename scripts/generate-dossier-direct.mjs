#!/usr/bin/env node
/**
 * Generate the case dossier OUT-OF-BAND and write it straight to Turso.
 *
 * The in-app /api/admin/dossier route does the same thing, but on serverless
 * (Vercel) the single large LLM call exceeds the function timeout. This script
 * runs anywhere with no time limit: it reads the indexed chunks from Turso,
 * makes the synthesis call, and upserts the dossier into the app_kv table — the
 * exact row the app reads on case questions.
 *
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *   OPENAI_API_KEY=... OPENAI_MODEL=gpt-5.5 \
 *   node scripts/generate-dossier-direct.mjs
 *
 * Mirrors lib/dossier/generate.ts (budgets + system prompt) so the result is
 * identical to the in-app generation.
 */

import { createClient } from "@libsql/client";
import OpenAI from "openai";

const TOTAL_BUDGET_CHARS = 600_000;
const PER_DOC_CAP_CHARS = 4_000;

const DOSSIER_SYSTEM = `Du lager et grundig, gjennomarbeidet SAKSDOSSIER for Nornebygg- og HEYAS-siden (Hausvik Energy Yard AS, konsortiet Nornebygg/Fjellbygg er en del av) ut fra utdrag av alle sakens dokumenter. Du står på lag med dette teamet — målet er at de skal ha en dyp og realistisk forståelse av saken. Skriv på norsk, og bygg KUN på det som faktisk står i utdragene.

Dette er ikke et overflatisk sammendrag. Les utdragene nøye, koble informasjon på tvers av dokumenter, og analyser saken grundig. Strukturér dossieret med disse overskriftene (utelat en seksjon hvis det ikke finnes grunnlag for den):
- **Sakens kjerne**: hva handler saken egentlig om, kort og presist (2–4 setninger).
- **Parter**: hvem er involvert (Nornebygg/HEYAS, motpart(er), rådgivere, offentlige instanser) og deres rolle.
- **Tidslinje**: sentrale hendelser i kronologisk rekkefølge, med datoer der de finnes.
- **Sentrale avtaler og dokumenter**: nøkkeldokumenter, hva de regulerer og hvorfor de er viktige, med dokumentnavn.
- **Omtvistede punkter**: hva partene er uenige om. For hvert punkt: gjengi kort hva HEYAS-siden anfører OG hva motparten anfører, slik det fremgår av dokumentene.
- **Styrker for HEYAS-siden**: dokumenterte forhold som taler til teamets fordel, med kildehenvisning.
- **Svakheter og risikoer for HEYAS-siden**: forhold som taler MOT teamet, ugunstige dokumenter, hull eller uklarheter i egen sak. Vær ærlig og direkte her — dette er det viktigste for at teamet skal være forberedt. Underslå ingenting ufordelaktig.
- **Frister og forpliktelser**: datoer, frister eller plikter som nevnes.
- **Åpne spørsmål**: hva er uklart, mangelfullt belyst eller motstridende i materialet.
- **Status**: hvor saken ser ut til å stå nå.

Regler:
- Henvis til dokumentnavn når du oppgir et faktum (f.eks. «(Avtale med Windport Signert)»).
- Finn ALDRI på fakta, datoer, beløp eller konklusjoner. Står det ikke i utdragene, ta det ikke med. Pynt aldri på noe til fordel for HEYAS.
- Vær ærlig også når faktum IKKE er i HEYAS' favør. En god støttespiller skjuler ikke svakheter — den synliggjør dem så teamet kan håndtere dem.
- Gi ALDRI juridiske råd og konkludér ikke om endelig utfall eller skyld. Du kan analysere hva dokumentene viser av styrker og svakheter, men juridisk strategi og vurdering tilhører advokaten.
- Er noe uklart eller motstridende, si det tydelig.
- Vær grundig men oversiktlig. Bruk punktlister og korte forklaringer.`;

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
const model = process.env.OPENAI_MODEL || "gpt-5.5";
if (!url || !process.env.OPENAI_API_KEY) {
  console.error("Set TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, OPENAI_API_KEY (+ OPENAI_MODEL).");
  process.exit(1);
}

const t0 = Date.now();
const db = createClient({ url, ...(authToken ? { authToken } : {}) });

// Read all chunks (text + order) grouped by document.
const res = await db.execute("SELECT name, chunks FROM kb_documents");
const byDoc = new Map();
for (const row of res.rows) {
  const name = String(row.name);
  const chunks = JSON.parse(String(row.chunks));
  const list = byDoc.get(name) ?? [];
  for (const c of chunks) list.push({ i: c.chunkIndex, text: c.text });
  byDoc.set(name, list);
}
const docCount = byDoc.size;
if (docCount === 0) {
  console.error("No documents in kb_documents — run the sync first.");
  process.exit(1);
}

const perDoc = Math.min(PER_DOC_CAP_CHARS, Math.max(400, Math.floor(TOTAL_BUDGET_CHARS / docCount)));
const parts = [];
for (const [name, chunks] of byDoc) {
  const text = chunks.sort((a, b) => a.i - b.i).map((c) => c.text).join("\n").slice(0, perDoc).trim();
  if (text) parts.push(`### ${name}\n${text}`);
}
const input = parts.join("\n\n");
console.log(`Bygde input fra ${docCount} dokumenter (${input.length} tegn). Kaller ${model}…`);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const completion = await openai.chat.completions.create({
  model,
  messages: [
    { role: "system", content: DOSSIER_SYSTEM },
    { role: "user", content: `DOKUMENTUTDRAG:\n\n${input}` },
  ],
});
const text = (completion.choices[0]?.message?.content ?? "").trim();
if (!text) {
  console.error("LLM returnerte tom tekst.");
  process.exit(1);
}

const dossier = { generatedAt: new Date().toISOString(), documentCount: docCount, text };
await db.execute("CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
await db.execute({
  sql: "INSERT INTO app_kv(key, value) VALUES ('dossier', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  args: [JSON.stringify(dossier)],
});

console.log(`✅ Dossier skrevet til Turso: ${docCount} docs, ${text.length} tegn, ${((Date.now() - t0) / 1000).toFixed(0)}s totalt.`);
