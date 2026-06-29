/**
 * Case-dossier generation.
 *
 * Synthesises a single structured overview of the whole case from every indexed
 * document, in one LLM call over a budgeted excerpt of each document. Run on
 * demand (admin route / script), never in the chat request path.
 *
 * The dossier is a navigation aid: it gives the bot the big picture, while the
 * answer still cites the underlying documents and defers legal judgement to the
 * lawyer (enforced by the system prompt). Server-side only.
 */

import "server-only";
import { env } from "@/lib/env";
import { getAllChunks } from "@/lib/documents/store";
import { getLLMProvider } from "@/lib/llm";
import { writeDossier, type Dossier } from "@/lib/dossier/store";

/** Total character budget for the synthesis input (~150k tokens of excerpts). */
const TOTAL_BUDGET_CHARS = 600_000;
/** Floor so every document is represented, even on a large corpus. */
const PER_DOC_MIN_CHARS = 400;
/**
 * Per-document ceiling so one huge file can't crowd out the rest. Raised from 4k:
 * on a small/medium corpus each document now gets a substantial excerpt (and the
 * full budget is actually used) instead of only its first ~1k tokens.
 */
const PER_DOC_CAP_CHARS = 40_000;
/**
 * Output cap for the dossier synthesis. The interactive-chat default (~4k tokens)
 * truncates a thorough multi-section legal overview; this leaves room for the
 * full structure (kjerne, parter, tidslinje, styrker/svakheter, …).
 */
const DOSSIER_MAX_TOKENS = 16_000;

/**
 * Model for the one-off dossier synthesis: an explicit DOSSIER_MODEL override, or
 * a top-tier default for the active provider (Opus on Anthropic — the chat
 * default is Sonnet). Outside the request path, so quality beats cost. Other
 * providers keep their configured model (the out-of-band script sets its own).
 */
function dossierModel(): string | undefined {
  const explicit = env.dossier.model();
  if (explicit) return explicit;
  return env.llm.provider() === "anthropic" ? "claude-opus-4-8" : undefined;
}

/**
 * Pick up to `budget` chars from one document's chunks. If the whole document
 * fits, it's included in chunk order. If not, chunks are sampled EVENLY across
 * the document (start → middle → end) instead of taking only the opening — so the
 * excerpt represents the whole file (where claims, amounts and signatures often
 * live), not just its first page. Omitted spans are marked with "…".
 */
export function selectExcerpt(
  chunks: { i: number; text: string }[],
  budget: number,
): string {
  const ordered = [...chunks].sort((a, b) => a.i - b.i);
  const whole = ordered.map((c) => c.text).join("\n");
  if (whole.length <= budget) return whole.trim();

  const avg = whole.length / ordered.length;
  const want = Math.max(1, Math.min(ordered.length, Math.floor(budget / Math.max(1, avg))));
  const step = ordered.length / want;
  const picked: string[] = [];
  const seen = new Set<number>();
  let used = 0;
  for (let k = 0; k < want; k++) {
    const idx = Math.min(ordered.length - 1, Math.floor(k * step));
    if (seen.has(idx)) continue;
    seen.add(idx);
    const t = ordered[idx].text;
    if (used + t.length > budget && picked.length) break;
    picked.push(t);
    used += t.length + 1;
  }
  return picked.join("\n…\n").slice(0, budget).trim();
}

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

/** Build per-document excerpts (name + leading text), within a total budget. */
function buildInput(
  chunks: Awaited<ReturnType<typeof getAllChunks>>,
): { input: string; documentCount: number } {
  // Group chunks by document, preserving order.
  const byDoc = new Map<string, { name: string; chunks: { i: number; text: string }[] }>();
  for (const c of chunks) {
    const entry = byDoc.get(c.documentId) ?? { name: c.documentName, chunks: [] };
    entry.chunks.push({ i: c.chunkIndex, text: c.text });
    byDoc.set(c.documentId, entry);
  }

  const docCount = byDoc.size;
  if (docCount === 0) return { input: "", documentCount: 0 };

  // Share the budget across documents, capped per document.
  const perDoc = Math.min(
    PER_DOC_CAP_CHARS,
    Math.max(PER_DOC_MIN_CHARS, Math.floor(TOTAL_BUDGET_CHARS / docCount)),
  );

  const parts: string[] = [];
  for (const { name, chunks: docChunks } of byDoc.values()) {
    const text = selectExcerpt(docChunks, perDoc);
    if (text) parts.push(`### ${name}\n${text}`);
  }
  return { input: parts.join("\n\n"), documentCount: docCount };
}

/**
 * Generate (and persist) the case dossier from all indexed documents.
 * Returns the dossier, or null when there are no documents to summarise.
 */
export async function generateDossier(): Promise<Dossier | null> {
  const chunks = await getAllChunks();
  const { input, documentCount } = buildInput(chunks);
  if (documentCount === 0) return null;

  const provider = getLLMProvider();
  let truncated = false;
  const text = (
    await provider.generateAnswer({
      systemPrompt: DOSSIER_SYSTEM,
      userPrompt: `DOKUMENTUTDRAG:\n\n${input}`,
      context: {},
      maxTokens: DOSSIER_MAX_TOKENS,
      model: dossierModel(),
      onTruncated: () => {
        truncated = true;
      },
    })
  ).trim();

  if (!text) return null;

  if (truncated) {
    // The synthesis hit the output cap — the dossier may be missing its final
    // sections. Surface it (and persist the flag) instead of failing silently.
    console.warn(
      JSON.stringify({
        evt: "dossier_truncated",
        documentCount,
        maxTokens: DOSSIER_MAX_TOKENS,
        note: "Dossier hit the output cap; consider raising DOSSIER_MAX_TOKENS.",
      }),
    );
  }

  const dossier: Dossier = {
    generatedAt: new Date().toISOString(),
    documentCount,
    text,
    ...(truncated ? { truncated: true } : {}),
  };
  await writeDossier(dossier);
  return dossier;
}
