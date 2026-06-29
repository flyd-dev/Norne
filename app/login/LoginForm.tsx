"use client";

import { useState } from "react";

export default function LoginForm({ next }: { next: string }) {
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
        // Full sidelasting: garanterer at den nye cookien sendes og at
        // middleware slipper deg inn. Unngår at knappen henger.
        window.location.assign(next);
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
    <div className="login-app">
      <div className="login-card">
        <div className="login-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="login-logo"
            src="/norne-logo-gold.png"
            alt="Norne"
          />
          <p className="login-kicker">Intern prosjektassistent</p>
        </div>

        <div className="login-body">
          <h1>Logg inn</h1>
          <p className="login-lead">Tilgang krever brukernavn og passord.</p>

          {error ? <div className="error login-error">{error}</div> : null}

          <form className="login-form" onSubmit={onSubmit}>
            <label className="login-field">
              <span className="login-label">Brukernavn</span>
              <input
                type="text"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                required
              />
            </label>
            <label className="login-field">
              <span className="login-label">Passord</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button
              type="submit"
              className="send-btn login-submit"
              disabled={loading}
            >
              {loading ? "Logger inn…" : "Logg inn"}
            </button>
          </form>

          <p className="login-foot">Robust. Presis. Tilstede.</p>
        </div>
      </div>
    </div>
  );
}
