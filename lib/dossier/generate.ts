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

/** Total character budget for the synthesis input (~150k tokens of excerpts). */
const TOTAL_BUDGET_CHARS = 600_000;
/** Hard per-document cap so one huge file can't crowd out the rest. */
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
