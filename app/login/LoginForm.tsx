"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
      });
      if (res.ok) {
        router.replace(next);
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || "Innlogging feilet.");
        setLoading(false);
      }
    } catch {
      setError("Noe gikk galt. Prøv igjen.");
      setLoading(false);
    }
  }

  return (
    <div className="admin-app">
      <div className="admin-card">
        <div className="admin-gate">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="gate-logo"
            src="/norne-logo-gold.png"
            alt="Norne"
          />
          <h1>Logg inn</h1>
          <p>Tilgang krever brukernavn og passord.</p>

          {error ? <div className="error login-error">{error}</div> : null}

          <form className="login-form" onSubmit={onSubmit}>
            <input
              type="text"
              placeholder="Brukernavn"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
              required
            />
            <input
              type="password"
              placeholder="Passord"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="submit"
              className="send-btn login-submit"
              disabled={loading}
            >
              {loading ? "Logger inn…" : "Logg inn"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
