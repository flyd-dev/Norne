import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE,
  checkCredentials,
  expectedToken,
} from "@/lib/site-auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { user?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ugyldig forespørsel." }, { status: 400 });
  }

  const user = typeof body.user === "string" ? body.user : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!checkCredentials(user, password)) {
    return NextResponse.json(
      { error: "Feil brukernavn eller passord." },
      { status: 401 }
    );
  }

  // Sett Secure-flagget kun når forespørselen faktisk er HTTPS. Ellers (ren
  // HTTP på VPS-en) ville nettleseren forkaste cookien, og login ville loope.
  const proto =
    req.headers.get("x-forwarded-proto") ||
    req.nextUrl.protocol.replace(":", "");
  const isHttps = proto.split(",")[0].trim() === "https";

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await expectedToken(), {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}

// Logg ut: tøm cookien.
export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
