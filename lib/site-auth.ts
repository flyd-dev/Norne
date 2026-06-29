// Delt logikk for passordlåsen som dekker hele siden.
// Brukes både av middleware (Edge) og login-API-ruten (Node) — derfor kun
// Web Crypto (crypto.subtle), som finnes begge steder.

export const AUTH_COOKIE = "norne_auth";

// I PRODUKSJON kreves SITE_AUTH_PASSWORD og SITE_AUTH_SECRET. Det finnes BEVISST
// ingen innebygd standard for disse: uten dem skal appen låse seg (fail closed)
// i stedet for å verne hele siden — inkludert det konfidensielle saksdossieret —
// med et passord som ligger i kildekoden (og git-historikken). I utvikling
// faller vi tilbake til åpenbare, ikke-hemmelige plassholdere så `next dev`
// fungerer uten oppsett; disse gir ingen reell beskyttelse og brukes aldri i
// produksjon. Brukernavnet er ikke en hemmelighet og kan beholde en standard.
const IS_PROD = process.env.NODE_ENV === "production";
const USER = process.env.SITE_AUTH_USER || "Admin";
const PASSWORD = process.env.SITE_AUTH_PASSWORD || (IS_PROD ? "" : "dev-passord-bytt-meg");
const SECRET = process.env.SITE_AUTH_SECRET || (IS_PROD ? "" : "dev-hemmelighet-bytt-meg");

/** True bare når passordlåsen faktisk er konfigurert (begge hemmeligheter satt). */
function lockConfigured(): boolean {
  return Boolean(PASSWORD && SECRET);
}

// 30 dager innlogget.
export const AUTH_MAX_AGE = 60 * 60 * 24 * 30;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Tokenet som lagres i cookien. Det er en hash av bruker+passord+hemmelighet,
// så selve passordet ligger aldri i klartekst i nettleseren, og cookien kan
// ikke forfalskes uten å kjenne hemmeligheten.
export async function expectedToken(): Promise<string> {
  // Fail closed: uten konfigurert passord/secret (typisk en produksjonsdeploy som
  // mangler env-variablene) skal ingen cookie kunne validere. Returner en
  // uforutsigbar verdi som aldri matcher en lagret cookie, i stedet for å regne
  // ut et token fra en kjent standard — da ville hele siden vært åpen.
  if (!lockConfigured()) return `__locked__:${crypto.randomUUID()}`;
  const data = new TextEncoder().encode(`${USER}:${PASSWORD}:${SECRET}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export function checkCredentials(user: string, password: string): boolean {
  if (!lockConfigured()) return false;
  return user === USER && password === PASSWORD;
}
