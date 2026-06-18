"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface DocumentRecord {
  id: string;
  name: string;
  fileType: string;
  uploadedAt: string;
  chunkCount: number;
}

const TOKEN_KEY = "norne_admin_token";
const ACCEPT = ".pdf,.docx,.txt,.csv,.xlsx";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("no-NO");
}

export default function AdminDocuments() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Restore a previously entered token (browser session only).
  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
  }, []);

  const authHeaders = useCallback(
    (t: string): HeadersInit => ({ Authorization: `Bearer ${t}` }),
    [],
  );

  const loadDocuments = useCallback(
    async (t: string): Promise<boolean> => {
      setError(null);
      const res = await fetch("/api/admin/documents", {
        headers: authHeaders(t),
      });
      if (res.status === 401) {
        setError("Feil token. Prøv igjen.");
        return false;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Kunne ikke hente dokumenter.");
        return false;
      }
      const data = await res.json();
      setDocuments(data.documents ?? []);
      return true;
    },
    [authHeaders],
  );

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    const ok = await loadDocuments(token.trim());
    if (ok) {
      sessionStorage.setItem(TOKEN_KEY, token.trim());
      setAuthed(true);
    }
    setBusy(false);
  }

  function lock() {
    sessionStorage.removeItem(TOKEN_KEY);
    setAuthed(false);
    setDocuments([]);
    setToken("");
    setStatus(null);
    setError(null);
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || busy) return;

    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/documents", {
        method: "POST",
        headers: authHeaders(token),
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Opplasting feilet.");
      } else {
        setStatus(
          `Lastet opp «${data.document.name}» (${data.document.chunkCount} biter).`,
        );
        if (fileRef.current) fileRef.current.value = "";
        await loadDocuments(token);
      }
    } catch {
      setError("Nettverksfeil under opplasting.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (busy) return;
    if (!confirm(`Slette «${name}»? Dette kan ikke angres.`)) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const res = await fetch(`/api/admin/documents/${id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Kunne ikke slette dokumentet.");
      } else {
        setStatus(`Slettet «${name}».`);
        await loadDocuments(token);
      }
    } catch {
      setError("Nettverksfeil under sletting.");
    } finally {
      setBusy(false);
    }
  }

  if (!authed) {
    return (
      <div className="admin-app">
        <div className="admin-card admin-gate">
          <img
            className="gate-logo"
            src="/norne-logo-gold.png"
            alt="Nornebygg"
            width={86}
            height={48}
          />
          <h1>Dokumentadministrasjon</h1>
          <p>Skriv inn admin-token for å fortsette.</p>
          <form onSubmit={unlock} className="gate-form">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Admin-token"
              autoComplete="off"
              aria-label="Admin-token"
            />
            <button type="submit" className="send-btn" disabled={busy || !token.trim()}>
              {busy ? "Sjekker …" : "Lås opp"}
            </button>
          </form>
          {error && <div className="error" role="alert">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-app">
      <div className="admin-card">
        <header className="admin-header">
          <div className="brand">
            <div>
              <h1>Dokumentadministrasjon</h1>
              <p>Last opp PDF, DOCX, TXT, CSV eller XLSX. Maks 10 MB per fil.</p>
            </div>
          </div>
          <button className="clear-btn" onClick={lock}>
            Lås
          </button>
        </header>

        <div className="divider-band" aria-hidden="true">
          <div className="logo-divider">
            <span className="ld-line" />
            <img className="ld-mark" src="/norne-logo-gold.png" alt="" />
            <span className="ld-line" />
          </div>
        </div>

        <form onSubmit={upload} className="upload-form">
          <input ref={fileRef} type="file" accept={ACCEPT} aria-label="Velg fil" />
          <button type="submit" className="send-btn" disabled={busy}>
            {busy ? "Laster opp …" : "Last opp"}
          </button>
        </form>

        {status && <div className="admin-status">{status}</div>}
        {error && <div className="error" role="alert">{error}</div>}

        <div className="admin-table-wrap">
          {documents.length === 0 ? (
            <p className="admin-empty">Ingen dokumenter er lastet opp ennå.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Navn</th>
                  <th>Type</th>
                  <th>Lastet opp</th>
                  <th>Biter</th>
                  <th aria-label="Handlinger" />
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td className="doc-name">{d.name}</td>
                    <td>
                      <span className="badge">{d.fileType.toUpperCase()}</span>
                    </td>
                    <td>{formatDate(d.uploadedAt)}</td>
                    <td>{d.chunkCount}</td>
                    <td>
                      <button
                        className="delete-btn"
                        onClick={() => void remove(d.id, d.name)}
                        disabled={busy}
                      >
                        Slett
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="disclaimer">
          Opplastede filer behandles på serveren; bare uttrukket tekst lagres for
          søk. Ikke last opp sensitive personopplysninger.
        </p>
      </div>
    </div>
  );
}
