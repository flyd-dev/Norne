/**
 * Meta / capabilities ("Hva kan du gjøre?") detection and answer.
 *
 * This is the FIRST gate in the assistant pipeline, before any follow-up
 * resolution, intent detection, routing or retrieval. A meta question is about
 * the assistant itself — what it can do, how to use it, examples — not about
 * company data. Treating it as a data question is the classic failure mode:
 * intent detection finds no keyword, defaults to projects+accounts, fetches
 * Firestore, attaches warnings, and answers as if the user asked for a project
 * summary.
 *
 * So when this matches we short-circuit with a deterministic answer and:
 *   - do NOT use Endre, Firestore, accounts, documents or the staffing plan,
 *   - do NOT inherit conversation history,
 *   - return no sources, no warnings, no retrieved data.
 *
 * Pure and dependency-free for easy testing.
 */

/**
 * The deterministic help answer. Static, source-free, never references live
 * project data — it only describes what the assistant can do, with examples.
 */
export const CAPABILITIES_ANSWER = `Jeg kan hjelpe deg med blant annet:

- Prosjekter: oppsummere prosjekt, finne kontraktsverdi, kostnader, fakturert beløp, resultat, datoer og timer.
- Endre-data: hente live prosjektdata for prosjekter som finnes i Endre.
- Kontoføring: foreslå riktig konto for innkjøp, for eksempel arbeidshansker, verneutstyr og materiell.
- Bemanning og kapasitet: vurdere kapasitet basert på bemanningsplan, roller, timer og måneder.
- Dokumenter: svare på spørsmål fra opplastede Excel-, PDF- og Word-filer.
- Oppfølgingsspørsmål: forstå spørsmål som «hva er kontraktsverdien?» når vi nettopp har snakket om et prosjekt.

Eksempler:

- Oppsummer prosjekt 7100
- Hva er kontraktsverdien på Pilestredet?
- Hva fører jeg arbeidshansker på?
- Har vi kapasitet til 29 000 timer i august?
- Vis tilgjengelig kapasitet frem til september 2026`;

/**
 * Normalize for meta matching: lowercase, strip punctuation (keep letters,
 * including æøå, and digits), collapse whitespace. The original message is never
 * mutated — this copy is only used for matching.
 */
export function normalizeForMeta(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Short messages that are help requests in their entirety. Matched against the
 * fully normalized message so "Hjelp!" or "Hjelp." still match, but
 * "hjelp meg å finne kontraktsverdien" does not (it has more words).
 */
const META_EXACT = new Set([
  "hjelp",
  "help",
  "vis hjelp",
  "trenger hjelp",
  "eksempler",
  "vis eksempler",
  "gi eksempler",
  "hva er dette",
  "hva er du",
  "hvem er du",
]);

/**
 * Phrasings that are meta even inside a longer sentence. Kept deliberately
 * specific so genuine data questions ("hjelp meg å finne …", "hvordan bruker jeg
 * konto 6570") are NOT swallowed.
 */
const META_PATTERNS: RegExp[] = [
  // "hva kan du gjøre / hjelpe med / brukes til"
  /\bhva kan du (gj(?:ø|o)re|hjelpe (meg )?med|hjelpe til med|brukes til)\b/,
  // "hva kan jeg / man spørre deg om / bruke deg til / spørre om"
  /\bhva kan (jeg|man) (sp(?:ø|o)rre (deg )?om|bruke deg til|spørre om|spore deg om)\b/,
  /\bhva kan jeg sp(?:ø|o)rre deg om\b/,
  // "hva kan boten / botten / assistenten / appen gjøre"
  /\bhva kan (boten|botten|assistenten|denne assistenten|appen|norne) gj(?:ø|o)re\b/,
  // "hvordan bruker / funker / fungerer jeg deg / du / assistenten"
  /\bhvordan (bruker|funker|fungerer) (jeg )?(deg|du|assistenten|denne|dette|norne)\b/,
  // "gi meg / vis (meg) eksempler (på hva du kan)"
  /\b(gi meg|vis( meg)?) eksempler\b/,
  // "hvilke spørsmål / ting kan jeg / du …"
  /\bhvilke (sp(?:ø|o)rsm(?:å|a)l|ting) kan (jeg|du)\b/,
];

/**
 * True when the message is a meta/help question about the assistant itself,
 * rather than a question about company data. Conservative on purpose: false
 * positives would hijack real data questions.
 */
export function isCapabilitiesQuestion(message: string): boolean {
  const normalized = normalizeForMeta(message);
  if (!normalized) return false;
  if (META_EXACT.has(normalized)) return true;
  return META_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Smalltalk / greetings: trivial conversational messages that are NOT data
 * questions ("hei", "funker du", "takk"). Without this gate they fall through to
 * the full pipeline and trigger document search + Endre — slow, and they cite
 * irrelevant sources. Matched ONLY as the entire normalized message (exact set),
 * so a real question like "funker budsjettet for 7100" is never swallowed.
 */
const SMALLTALK_GREETING = new Set([
  "hei", "heisann", "hallo", "halla", "yo", "hei norne", "hei der",
  "god morgen", "god dag", "god kveld", "morn", "morna",
]);
const SMALLTALK_WORKS = new Set([
  "funker du", "fungerer du", "funker det", "fungerer det", "funker dette",
  "er du der", "lever du", "er du på", "er du klar", "test", "testing",
]);
const SMALLTALK_THANKS = new Set([
  "takk", "tusen takk", "takk skal du ha", "mange takk", "thanks", "takk for hjelpen",
]);
const SMALLTALK_ACK = new Set([
  "ok", "okei", "okay", "greit", "skjønner", "skjonner", "ja", "nei", "supert", "flott",
]);

/** True when the whole message is trivial smalltalk (greeting/ack/thanks). */
export function isSmalltalkMessage(message: string): boolean {
  const n = normalizeForMeta(message);
  if (!n) return false;
  return (
    SMALLTALK_GREETING.has(n) ||
    SMALLTALK_WORKS.has(n) ||
    SMALLTALK_THANKS.has(n) ||
    SMALLTALK_ACK.has(n)
  );
}

/** A short, friendly reply for a smalltalk message — no data, no sources. */
export function smalltalkAnswer(message: string): string {
  const n = normalizeForMeta(message);
  if (SMALLTALK_WORKS.has(n)) return "Ja, jeg funker. Hva vil du sjekke?";
  if (SMALLTALK_THANKS.has(n)) return "Bare hyggelig! Si ifra om det er noe mer.";
  if (SMALLTALK_ACK.has(n)) return "👍 Si ifra om du lurer på noe.";
  return "Hei! Jeg er Norne Assistant. Spør meg om prosjekter, dokumenter, kontoføring, bemanning eller saken — hva vil du vite?";
}

/**
 * Broad, high-recall cue that a message is about Nornebygg's company data — the
 * projects, accounting, capacity, documents, or the legal case. Used to decide
 * whether to RETRIEVE (search documents / Endre / Firestore) or just answer
 * conversationally like a normal chat. Deliberately generous: it should err
 * toward "yes, this is about our data" so a real (keyword-light) question is
 * never answered conversationally and left un-retrieved. The conversational
 * fallback only fires when NONE of these appear AND there is no other signal.
 */
const DOMAIN_CUE =
  /\b(prosjekt\w*|project\w*|konto\w*|regnskap\w*|budsjett\w*|kostnad\w*|faktura\w*|fakturert|kontrakt\w*|resultat\w*|inntekt\w*|beløp|betal\w*|mengde\w*|kvantum|antall|time\w*|rolle\w*|fag|bemann\w*|kapasitet\w*|rotasjon\w*|ressurs\w*|endre|dokument\w*|vedlegg\w*|fil(?:en|er|ene)?|excel|pdf|word|sak\w*|saken|tvist\w*|rettssak\w*|hovedforhandling|stevning\w*|tilsvar\w*|motkrav\w*|erstatning\w*|opsjon\w*|avtale\w*|intensjonsavtale|frist\w*|forpliktelse\w*|møte\w*|referat\w*|korrespondanse|motpart\w*|advokat\w*|krav\w*|leie\w*|eiendom\w*|areal\w*|tomt\w*|tidslinje\w*|kommun\w*|lyngdal|hausvik|heyas|nornebygg|fjellbygg|velde|windport|forhandlingsutvalg\w*|formannskap\w*)\b/i;

/**
 * True when the message references the company-data domain (projects, accounting,
 * capacity, documents, or the case). High recall on purpose.
 */
export function mentionsCompanyDomain(message: string): boolean {
  return DOMAIN_CUE.test(message);
}

/** System prompt for the conversational (no-retrieval) path. */
export const CONVERSATION_SYSTEM = `Du er Norne Assistant, en intern assistent for Nornebygg. Dette er en vanlig samtalemelding som ikke handler om konkrete firmadata, så svar kort og naturlig som i en vanlig chat — uten å slå opp i dokumenter, prosjekter eller andre kilder.

- Svar på norsk (eller brukerens språk).
- IKKE finn på firmadata, tall, prosjekter, dokumentinnhold eller fakta om saken. Har du ikke fått dem i denne meldingen, har du dem ikke.
- Hvis brukeren ser ut til å ville vite noe om et prosjekt, et dokument, kontoføring, bemanning/kapasitet eller Nornebygg-saken, be dem si det konkret — da slår du det opp.
- Vær vennlig og kortfattet.`;
