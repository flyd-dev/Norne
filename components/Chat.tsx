"use client";

import { useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  warnings?: string[];
}

interface ApiResponse {
  answer?: string;
  sources?: string[];
  dataUsed?: {
    firestoreCollections: string[];
    documents: unknown[];
  };
  warnings?: string[];
  error?: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  }

  async function send() {
    const message = input.trim();
    if (!message || loading) return;

    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setLoading(true);
    scrollToBottom();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data: ApiResponse = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Forespørselen feilet (${res.status}).`);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer ?? "(tomt svar)",
          sources: data.sources,
          warnings: data.warnings,
        },
      ]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Ukjent feil. Prøv igjen.",
      );
    } finally {
      setLoading(false);
      scrollToBottom();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter adds a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Norne — intern assistent</h1>
        <p>Spør om prosjekter, kontoer, budsjettlinjer og mengder.</p>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && !loading && (
          <div className="empty">
            <p>Still et spørsmål for å komme i gang. For eksempel:</p>
            <p>
              <code>Hvilke prosjekter har vi?</code>
              <br />
              <code>Vis budsjettlinjer for prosjekt …</code>
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <div className="role">{m.role === "user" ? "Deg" : "Assistent"}</div>
            <div>{m.content}</div>
            {m.role === "assistant" && m.warnings && m.warnings.length > 0 && (
              <div className="warnings">
                {m.warnings.map((w, wi) => (
                  <div className="warning" key={wi}>
                    ⚠ {w}
                  </div>
                ))}
              </div>
            )}
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <div className="sources">
                Kilder:
                <br />
                {m.sources.map((s) => (
                  <span className="tag" key={s}>
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="loading">
            <span className="dot" />
            Henter svar …
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Skriv et spørsmål …"
          rows={1}
          disabled={loading}
        />
        <button onClick={() => void send()} disabled={loading || !input.trim()}>
          {loading ? "Sender …" : "Send"}
        </button>
      </div>
    </div>
  );
}
