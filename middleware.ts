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
  // Lås alt unntatt: login-siden, login-API-et, Next.js sine interne filer,
  // og alle statiske filer (alt som inneholder et punktum, f.eks. logo-png).
  matcher: ["/((?!login|api/login|_next/static|_next/image|.*\\..*).*)"],
};
