import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, expectedToken } from "@/lib/site-auth";

// Passordlås for HELE siden. Uten gyldig innloggings-cookie blir du sendt til
// /login. Selve login-siden, login-API-et og statiske filer er åpne (ellers
// kan ikke innloggingssiden vises).
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const expected = await expectedToken();

  if (token && token === expected) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Lås alt unntatt: login-siden, login-API-et, admin-API-et og cron-API-et (egne
  // bearer-token-ruter — maskin-endepunkter som brukes av scripts/Vercel Cron,
  // ikke nettleseren, og som er beskyttet av ADMIN_UPLOAD_TOKEN / CRON_SECRET
  // uavhengig av cookie-låsen), Next.js sine interne filer, og alle statiske
  // filer (alt med et punktum, f.eks. png).
  //
  // VIKTIG: `api/cron` MÅ stå her. Uten unntaket fanger cookie-låsen Vercel Cron
  // sitt GET-kall (det har bare `Authorization: Bearer <CRON_SECRET>`, ingen
  // cookie) og redirecter til /login, slik at nattlig synk + dossier-regenerering
  // aldri kjører.
  matcher: [
    "/((?!login|api/login|api/admin|api/cron|_next/static|_next/image|.*\\..*).*)",
  ],
};
