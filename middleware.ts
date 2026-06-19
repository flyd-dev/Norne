import { NextRequest, NextResponse } from "next/server";

// Enkel passordlås for HELE siden (HTTP Basic Auth).
// Alle med lenken må logge inn med brukernavn + passord før de slipper inn.
//
// Brukernavn/passord settes via miljøvariabler i produksjon:
//   SITE_AUTH_USER, SITE_AUTH_PASSWORD
// Faller tilbake til standardverdiene under hvis variablene ikke er satt,
// slik at låsen virker med en gang.
const USER = process.env.SITE_AUTH_USER || "Admin";
const PASSWORD = process.env.SITE_AUTH_PASSWORD || "Lyngdal1990";

function unauthorized(): NextResponse {
  return new NextResponse("Innlogging kreves", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Norne", charset="UTF-8"',
    },
  });
}

export function middleware(req: NextRequest): NextResponse {
  const header = req.headers.get("authorization");

  if (!header || !header.startsWith("Basic ")) {
    return unauthorized();
  }

  // "Basic base64(user:pass)" → dekod og sammenlign.
  let decoded = "";
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(":");
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? "" : decoded.slice(sep + 1);

  if (user === USER && pass === PASSWORD) {
    return NextResponse.next();
  }

  return unauthorized();
}

export const config = {
  // Lås alt unntatt Next.js sine egne statiske filer og favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
