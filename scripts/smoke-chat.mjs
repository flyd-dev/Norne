#!/usr/bin/env node
/**
 * Smoke-test the live assistant against the real /api/chat endpoint.
 *
 * Start the app first (npm run dev), then:
 *   node scripts/smoke-chat.mjs                 # default http://localhost:3000
 *   CHAT_URL=http://localhost:3001 node scripts/smoke-chat.mjs
 *
 * Runs the scenarios from the production transcript (incl. multi-turn ones,
 * where the previous answer is fed back as history) and prints, per turn:
 *   - the answer
 *   - route, toolsPlanned, toolsRun (with coverage), validation, sources
 *
 * Read-only: it only POSTs chat questions. No data is written anywhere.
 */

const BASE = process.env.CHAT_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE}/api/chat`;

/** Each scenario is a list of user turns; history accumulates across turns. */
const SCENARIOS = [
  { name: "Kapasitet per fag frem til september 2026", turns: [
    "Vis tilgjengelig kapasitet per fag frem til september 2026",
  ]},
  { name: "Kapasitet-behov (29 000 t, august)", turns: [
    "Har vi kapasitet til et prosjekt i august 2026 på 29 000 timer, fordelt 30 % Steel fixer, 60 % Carpenter og 10 % Welder?",
  ]},
  { name: "100 timer Carpenter i august", turns: [
    "Hvis vi trenger 100 timer Carpenter i august 2026, hvor mye kapasitet mangler eller har vi til overs?",
  ]},
  { name: "Tool-valg: total vs måned", turns: [
    "Har vi nok folk totalt?",
  ]},
  { name: "Prosjekt-oppfølging (arver 7100)", turns: [
    "Oppsummer prosjekt 7100",
    "Hva er kontraktsverdien?",
    "Hvor mye er fakturert, og hva er forventet resultat?",
  ]},
  { name: "Kontoføring", turns: [
    "Hva fører jeg arbeidshansker på?",
  ]},
  { name: "Endre kontraktsverdi-ærlighet", turns: [
    "Oppsummer prosjekt 3025",
    "Hva er kontraktsverdien på AFBO NORA?",
  ]},
  { name: "Sammenligning på tvers", turns: [
    "Sammenlign prosjekt 7100 og 3025. Hva vet du sikkert om begge, og hva mangler du data på?",
  ]},
  { name: "Aggregering (høyest forventet resultat)", turns: [
    "Finn prosjektet med høyest forventet resultat blant prosjektene du kjenner til, men ikke bland Endre-beløp med lokal prosjektdata hvis feltene ikke betyr det samme.",
  ]},
];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

async function ask(message, history) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function fmtTools(runs) {
  if (!runs || runs.length === 0) return "(ingen)";
  return runs.map((t) => `${t.tool}:${t.coverage}`).join(", ");
}

async function main() {
  // Fail fast with a friendly message if the server isn't up.
  try {
    await fetch(BASE, { method: "GET" });
  } catch {
    console.error(C.yellow(`Får ikke kontakt med ${BASE}. Start appen først: npm run dev`));
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  for (const scenario of SCENARIOS) {
    console.log("\n" + C.bold(C.cyan(`▶ ${scenario.name}`)));
    const history = [];
    for (const message of scenario.turns) {
      console.log(C.bold(`\n  DU: ${message}`));
      try {
        const r = await ask(message, history);
        const answer = (r.answer ?? "").trim();
        console.log("  " + C.green("BOT:"));
        for (const line of answer.split("\n")) console.log("    " + line);
        const d = r.diagnostics ?? {};
        console.log(C.dim(`    [route=${r.route ?? "?"} | planlagt=${(d.toolsPlanned ?? []).join(",") || "-"} | kjørt=${fmtTools(d.toolsRun)} | validering=${d.validationReason ?? "-"}]`));
        console.log(C.dim(`    [kilder: ${(r.sources ?? []).join(", ") || "-"}]`));
        history.push({ role: "user", content: message });
        history.push({ role: "assistant", content: answer });
        pass += 1;
      } catch (err) {
        console.log("  " + C.yellow(`FEIL: ${err.message}`));
        fail += 1;
      }
    }
  }
  console.log("\n" + C.bold(`Ferdig: ${pass} svar, ${fail} feil.`));
}

main();
