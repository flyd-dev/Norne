import LoginForm from "./LoginForm";

export const metadata = {
  title: "Logg inn — Norne",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("/login")
      ? next
      : "/";
  return <LoginForm next={dest} />;
}
