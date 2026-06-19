// Delt logikk for passordlåsen som dekker hele siden.
// Brukes både av middleware (Edge) og login-API-ruten (Node) — derfor kun
// Web Crypto (crypto.subtle), som finnes begge steder.

export const AUTH_COOKIE = "norne_auth";

// Verdier kan overstyres med miljøvariabler i produksjon. Standardverdiene
// gjør at låsen virker med en gang, uten ekstra oppsett.
const USER = process.env.SITE_AUTH_USER || "Admin";
const PASSWORD = process.env.SITE_AUTH_PASSWORD || "Lyngdal1990";
// Hemmelig "salt" for cookie-tokenet. Bytt gjerne i produksjon — da blir alle
// gamle innlogginger ugyldige.
const SECRET = process.env.SITE_AUTH_SECRET || "norne-bygg-laas-v1";

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
  const data = new TextEncoder().encode(`${USER}:${PASSWORD}:${SECRET}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export function checkCredentials(user: string, password: string): boolean {
  return user === USER && password === PASSWORD;
}
