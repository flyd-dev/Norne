"use client";

import { useEffect, useRef, useState } from "react";

interface DocumentReference {
  documentId: string;
  documentName: string;
  fileType: string;
  sheetName?: string;
  chunkIndex: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  warnings?: string[];
  firestoreCollections?: string[];
  documents?: DocumentReference[];
}

interface ApiResponse {
  answer?: string;
  sources?: string[];
  dataUsed?: {
    firestoreCollections?: string[];
    documents?: DocumentReference[];
  };
  warnings?: string[];
  error?: string;
  requestId?: string;
}

interface ChatError {
  message: string;
  requestId?: string;
}

const EXAMPLES = [
  "Hvilke prosjekter finnes?",
  "Oppsummer prosjekt 7100",
  "Hvilke budsjettlinjer finnes på prosjekt 7100?",
  "Hvilke mengder finnes på prosjekt 7100?",
];

/**
 * Lightweight, dependency-free renderer for assistant answers.
 * Preserves line breaks and renders `- `/`* ` bullet lists and `1.` numbered
 * lists. Plain text is kept as paragraphs with soft line breaks.
 */
function renderAnswer(text: string): React.ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let bullets: string[] = [];
  let ordered: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={key++}>
        {para.map((l, i) => (
          <span key={i}>
            {l}
            {i < para.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>,
    );
    para = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key++}>
        {bullets.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flushOrdered = () => {
    if (ordered.length === 0) return;
    blocks.push(
      <ol key={key++}>
        {ordered.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>,
    );
    ordered = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bulletMatch = line.match(/^\s*[-*•]\s+(.*)$/);
    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (bulletMatch) {
      flushPara();
      flushOrdered();
      bullets.push(bulletMatch[1]);
    } else if (orderedMatch) {
      flushPara();
      flushBullets();
      ordered.push(orderedMatch[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushBullets();
      flushOrdered();
    } else {
      flushBullets();
      flushOrdered();
      para.push(line);
    }
  }
  flushPara();
  flushBullets();
  flushOrdered();

  return <div className="answer">{blocks}</div>;
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  }

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  // Auto-grow the textarea up to the CSS max-height.
  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  async function sendMessage(text: string) {
    const message = text.trim();
    if (!message || loading) return;

    setError(null);
    setInput("");
    requestAnimationFrame(autoResize);
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      let data: ApiResponse = {};
      try {
        data = (await res.json()) as ApiResponse;
      } catch {
        // Non-JSON response (e.g. proxy/gateway error).
      }

      if (!res.ok || data.error) {
        setError({
          message:
            data.error ??
            "Kunne ikke hente svar akkurat nå. Prøv igjen om litt.",
          requestId: data.requestId,
        });
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer ?? "(tomt svar)",
          sources: data.sources,
          warnings: data.warnings,
          firestoreCollections: data.dataUsed?.firestoreCollections,
          documents: data.dataUsed?.documents,
        },
      ]);
    } catch {
      setError({
        message:
          "Nettverksfeil – fikk ikke kontakt med tjenesten. Sjekk tilkoblingen og prøv igjen.",
      });
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter adds a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  function clearChat() {
    setMessages([]);
    setError(null);
    setInput("");
    requestAnimationFrame(autoResize);
  }

  const isEmpty = messages.length === 0 && !loading && !error;

  return (
    <div className="app">
      <div className="shell">
        <header className="header">
          <div className="brand">
            <div className="logo" aria-hidden="true">
              N
            </div>
            <div>
              <h1>Norne Assistent</h1>
              <p>Spør om prosjekter, dokumenter, budsjettlinjer og mengder.</p>
              <p className="brandline">Robust. Presis. Tilstede.</p>
            </div>
          </div>
          <button
            className="clear-btn"
            onClick={clearChat}
            disabled={messages.length === 0 && !error}
            aria-label="Tøm chat"
          >
            Tøm chat
          </button>
        </header>

        <div className="messages" ref={listRef} aria-live="polite">
          {isEmpty && (
            <div className="empty">
              <h2>Norne Assistent</h2>
              <p>Still et spørsmål for å komme i gang, eller velg et eksempel:</p>
              <div className="chips">
                {EXAMPLES.map((q) => (
                  <button
                    key={q}
                    className="chip"
                    onClick={() => void sendMessage(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div className={`row ${m.role}`} key={i}>
              <div className="bubble">
                <div className="role">
                  {m.role === "user" ? "Deg" : "Norne Assistent"}
                </div>

                {m.role === "assistant" ? (
                  renderAnswer(m.content)
                ) : (
                  <div className="answer">{m.content}</div>
                )}

                {m.role === "assistant" &&
                  m.warnings &&
                  m.warnings.length > 0 && (
                    <div className="warnings">
                      {m.warnings.map((w, wi) => (
                        <div className="warning" key={wi}>
                          ⚠ {w}
                        </div>
                      ))}
                    </div>
                  )}

                {m.role === "assistant" &&
                  m.sources &&
                  m.sources.length > 0 && (
                    <div className="sources">
                      <span className="sources-label">Kilder:</span>
                      {m.sources.map((s) => (
                        <span className="badge" key={s}>
                          {s}
                        </span>
                      ))}
                    </div>
                  )}

                {m.role === "assistant" &&
                  ((m.firestoreCollections?.length ?? 0) > 0 ||
                    (m.documents?.length ?? 0) > 0) && (
                    <details className="datasource">
                      <summary>Datagrunnlag</summary>
                      {m.firestoreCollections &&
                        m.firestoreCollections.length > 0 && (
                          <div className="ds-group">
                            <div className="ds-group-label">
                              Firestore-samlinger
                            </div>
                            <ul>
                              {m.firestoreCollections.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      {m.documents && m.documents.length > 0 && (
                        <div className="ds-group">
                          <div className="ds-group-label">Dokumenter</div>
                          <ul>
                            {m.documents.map((d, di) => (
                              <li key={`${d.documentId}-${d.chunkIndex}-${di}`}>
                                {d.documentName} (del {d.chunkIndex}
                                {d.sheetName ? `, ark ${d.sheetName}` : ""})
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </details>
                  )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="row assistant">
              <div className="bubble">
                <div className="loading">
                  <span className="dots">
                    <span />
                    <span />
                    <span />
                  </span>
                  Henter svar …
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="error" role="alert">
              {error.message}
              {error.requestId && (
                <div className="request-id">Referanse: {error.requestId}</div>
              )}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize();
              }}
              onKeyDown={onKeyDown}
              placeholder="Spør om et prosjekt, budsjettlinjer eller mengder..."
              rows={1}
              disabled={loading}
              aria-label="Skriv en melding"
            />
            <button
              className="send-btn"
              onClick={() => void sendMessage(input)}
              disabled={loading || !input.trim()}
            >
              {loading ? "Sender …" : "Send"}
            </button>
          </div>
          <p className="disclaimer">
            Svar baseres på tilgjengelige prosjektdata og opplastede dokumenter.
            Ikke del sensitive opplysninger i chatten.
          </p>
        </div>
      </div>
    </div>
  );
}
