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
import { getAllChunks } from "@/lib/documents/store";
import { getLLMProvider } from "@/lib/llm";
import { writeDossier, type Dossier } from "@/lib/dossier/store";

/** Total character budget for the synthesis input (~100k tokens of excerpts). */
const TOTAL_BUDGET_CHARS = 400_000;
/** Hard per-document cap so one huge file can't crowd out the rest. */
const PER_DOC_CAP_CHARS = 2_500;

const DOSSIER_SYSTEM = `Du lager et strukturert SAKSDOSSIER for Nornebygg-teamet ut fra utdrag av alle sakens dokumenter. Skriv på norsk, og bygg KUN på det som faktisk står i utdragene.

Strukturér dossieret med disse overskriftene (utelat en seksjon hvis det ikke finnes grunnlag for den):
- **Parter**: hvem er involvert (Nornebygg, motpart(er), rådgivere, offentlige instanser).
- **Tidslinje**: sentrale hendelser i kronologisk rekkefølge, med datoer der de finnes.
- **Sentrale avtaler og dokumenter**: nøkkeldokumenter og hva de gjelder, med dokumentnavn.
- **Omtvistede punkter**: hva saken/tvisten ser ut til å handle om.
- **Frister og forpliktelser**: datoer, frister eller plikter som nevnes.
- **Status**: hvor saken ser ut til å stå nå.

Regler:
- Henvis til dokumentnavn når du oppgir et faktum (f.eks. «(Avtale med Windport Signert)»).
- Finn ALDRI på fakta, datoer, beløp eller konklusjoner. Står det ikke i utdragene, ta det ikke med.
- Gi ALDRI juridiske råd og spekuler ikke i utfall eller skyld. Dette er et oppslagsverk, ikke en vurdering.
- Er noe uklart eller motstridende, si det kort.
- Vær konsis og oversiktlig. Bruk punktlister.`;

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
    Math.max(400, Math.floor(TOTAL_BUDGET_CHARS / docCount)),
  );

  const parts: string[] = [];
  for (const { name, chunks: docChunks } of byDoc.values()) {
    const text = docChunks
      .sort((a, b) => a.i - b.i)
      .map((c) => c.text)
      .join("\n")
      .slice(0, perDoc)
      .trim();
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
  const text = (
    await provider.generateAnswer({
      systemPrompt: DOSSIER_SYSTEM,
      userPrompt: `DOKUMENTUTDRAG:\n\n${input}`,
      context: {},
    })
  ).trim();

  if (!text) return null;

  const dossier: Dossier = {
    generatedAt: new Date().toISOString(),
    documentCount,
    text,
  };
  await writeDossier(dossier);
  return dossier;
}
