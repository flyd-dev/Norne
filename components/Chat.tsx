"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseBlocks,
  type Block,
  type InlineNode,
} from "@/lib/markdown/markdown";

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
  route?: string;
  /** The user question this answer responded to (for feedback). */
  question?: string;
}

interface ApiResponse {
  answer?: string;
  sources?: string[];
  dataUsed?: {
    firestoreCollections?: string[];
    documents?: DocumentReference[];
  };
  warnings?: string[];
  route?: string;
  error?: string;
  requestId?: string;
}

interface ChatError {
  message: string;
  requestId?: string;
}

// Starter chips. These are the bot's first impression, so they showcase its
// BREADTH — general work help (the default mode), staffing/capacity, projects,
// and the chart of accounts — not just repeated lookups of one project number.
const EXAMPLES = [
  "Lag en sjekkliste for oppstart av et byggeprosjekt",
  "Har vi ledig kapasitet i høst?",
  "Hvilke prosjekter finnes?",
  "Oppsummer prosjekt 7100",
  "Hvilken konto fører jeg verneutstyr på?",
];

/**
 * Render parsed inline nodes (bold / emphasis / inline code / text) to React.
 * Builds real elements — there is no HTML string, so nothing the model writes
 * can be injected as markup.
 */
function renderInline(nodes: InlineNode[]): React.ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.value}</span>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code className="answer-code" key={i}>
            {node.value}
          </code>
        );
    }
  });
}

/**
 * Safe Markdown renderer for assistant answers. Parses the text into a plain
 * data tree (lib/markdown) and renders it with React elements: **bold**,
 * headings (rendered as compact section titles, never giant H1s), bullet and
 * numbered lists, fenced code blocks, and soft line breaks. No
 * `dangerouslySetInnerHTML`, no raw HTML from the model.
 */
function renderBlock(block: Block, key: number): React.ReactNode {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      return (
        <p className={`answer-heading answer-h${level}`} key={key}>
          {renderInline(block.inline)}
        </p>
      );
    }
    case "paragraph":
      return (
        <p key={key}>
          {block.lines.map((line, i) => (
            <span key={i}>
              {renderInline(line)}
              {i < block.lines.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      );
    case "bullets":
      return (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "ordered":
      return (
        <ol key={key}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="answer-pre" key={key}>
          <code>{block.code}</code>
        </pre>
      );
  }
}

function renderAnswer(text: string): React.ReactNode {
  const blocks = parseBlocks(text);
  return (
    <div className="answer">{blocks.map((b, i) => renderBlock(b, i))}</div>
  );
}

/**
 * Feedback controls under an assistant answer. "Bra svar" stores a thumbs-up;
 * "Dårlig svar" reveals a textarea asking what the answer should have been. The
 * payload carries only what the user already saw (question, answer, sources,
 * route) — no chat history and no document contents.
 */
function MessageFeedback({ message }: { message: ChatMessage }) {
  const [state, setState] = useState<"idle" | "correcting" | "sent">("idle");
  const [correction, setCorrection] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(rating: "good" | "bad", text?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          question: message.question ?? "",
          answer: message.content,
          sources: message.sources ?? [],
          route: message.route ?? null,
          correction: text ?? null,
        }),
      });
      setState("sent");
    } catch {
      // Feedback is best-effort; silently ignore network errors.
      setState("sent");
    } finally {
      setBusy(false);
    }
  }

  if (state === "sent") {
    return <div className="feedback-thanks">Takk for tilbakemeldingen.</div>;
  }

  return (
    <div className="feedback">
      {state === "idle" && (
        <div className="feedback-buttons">
          <button
            className="feedback-btn"
            onClick={() => void send("good")}
            disabled={busy}
          >
            Bra svar
          </button>
          <button
            className="feedback-btn"
            onClick={() => setState("correcting")}
            disabled={busy}
          >
            Dårlig svar
          </button>
        </div>
      )}
      {state === "correcting" && (
        <div className="feedback-correct">
          <label htmlFor={`fb-${message.question ?? ""}`}>
            Hva burde svaret vært?
          </label>
          <textarea
            id={`fb-${message.question ?? ""}`}
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            rows={3}
            placeholder="Beskriv kort hva det riktige svaret er …"
          />
          <div className="feedback-buttons">
            <button
              className="feedback-btn"
              onClick={() => void send("bad", correction)}
              disabled={busy}
            >
              Send tilbakemelding
            </button>
            <button
              className="feedback-btn ghost"
              onClick={() => setState("idle")}
              disabled={busy}
            >
              Avbryt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
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

  // Merge fields into the most recent assistant message (the one being streamed).
  function patchLastAssistant(patch: Partial<ChatMessage>) {
    setMessages((prev) => {
      const copy = [...prev];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant") {
          copy[i] = { ...copy[i], ...patch };
          break;
        }
      }
      return copy;
    });
  }

  async function sendMessage(text: string) {
    const message = text.trim();
    if (!message || loading || streaming) return;

    setError(null);
    setInput("");
    requestAnimationFrame(autoResize);
    // Recent context for follow-up references ("sjekk den"): the prior turns,
    // not the message we're about to send. Kept short and not persisted.
    const history = messages.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history, stream: true }),
      });

      // Errors (validation/config) come back as plain JSON with a non-2xx status.
      if (!res.ok || !res.body) {
        let data: ApiResponse = {};
        try {
          data = (await res.json()) as ApiResponse;
        } catch {
          /* non-JSON */
        }
        setError({
          message:
            data.error ?? "Kunne ikke hente svar akkurat nå. Prøv igjen om litt.",
          requestId: data.requestId,
        });
        return;
      }

      // Read the newline-delimited JSON stream and render the answer as it lands.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let started = false; // have we created the assistant bubble yet?

      const handleEvent = (evt: {
        type: string;
        text?: string;
        answer?: string;
        sources?: string[];
        warnings?: string[];
        dataUsed?: ApiResponse["dataUsed"];
        route?: string;
        error?: string;
        requestId?: string;
      }) => {
        if (evt.type === "token" && evt.text) {
          if (!started) {
            started = true;
            setLoading(false);
            setStreaming(true);
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: evt.text ?? "", question: message },
            ]);
          } else {
            const chunk = evt.text;
            setMessages((prev) => {
              const copy = [...prev];
              for (let i = copy.length - 1; i >= 0; i--) {
                if (copy[i].role === "assistant") {
                  copy[i] = { ...copy[i], content: copy[i].content + chunk };
                  break;
                }
              }
              return copy;
            });
          }
        } else if (evt.type === "done") {
          const finalMsg: ChatMessage = {
            role: "assistant",
            content: evt.answer ?? "(tomt svar)",
            sources: evt.sources,
            warnings: evt.warnings,
            firestoreCollections: evt.dataUsed?.firestoreCollections,
            documents: evt.dataUsed?.documents,
            route: evt.route,
            question: message,
          };
          if (!started) {
            // No tokens were streamed (deterministic/guarded answer): add it now.
            setMessages((prev) => [...prev, finalMsg]);
          } else {
            patchLastAssistant(finalMsg);
          }
          setStreaming(false);
        } else if (evt.type === "error") {
          setStreaming(false);
          setError({
            message:
              evt.error ?? "Kunne ikke hente svar akkurat nå. Prøv igjen om litt.",
            requestId: evt.requestId,
          });
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            /* ignore malformed line */
          }
        }
      }
    } catch {
      setStreaming(false);
      setError({
        message:
          "Nettverksfeil – fikk ikke kontakt med tjenesten. Sjekk tilkoblingen og prøv igjen.",
      });
    } finally {
      setLoading(false);
      setStreaming(false);
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
            <img
              className="header-logo"
              src="/norne-logo-transparent.png"
              alt="Nornebygg"
              width={112}
              height={62}
            />
            <span className="brand-rule" aria-hidden="true" />
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
              <div className="logo-divider" aria-hidden="true">
                <span className="ld-line" />
                <img className="ld-mark" src="/norne-logo-gold.png" alt="" />
                <span className="ld-line" />
              </div>
              <h2>Norne Assistent</h2>
              <p>Spør om prosjekter, bemanning, dokumenter og saken — eller få hjelp med tekst og oppgaver.</p>
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
                  <>
                    {renderAnswer(m.content)}
                    {streaming && i === messages.length - 1 && (
                      <span className="stream-caret" aria-hidden="true">
                        ▍
                      </span>
                    )}
                  </>
                ) : (
                  <div className="answer">{m.content}</div>
                )}

                {m.role === "assistant" &&
                  (() => {
                    // Keep warnings relevant: truncation notices about accounts/
                    // projects only make sense for account/project answers. Drop
                    // them on capacity/document answers so they don't add noise.
                    const accountish =
                      m.route === undefined ||
                      [
                        "account_lookup",
                        "project_summary",
                        "budget_lines",
                        "quantities",
                      ].includes(m.route);
                    const warnings = (m.warnings ?? []).filter((w) => {
                      const isCountWarning = /^Viser kun \d+ av \d+/.test(w);
                      return accountish || !isCountWarning;
                    });
                    if (warnings.length === 0) return null;
                    return (
                      <div className="warnings">
                        {warnings.map((w, wi) => (
                          <div className="warning" key={wi}>
                            ⚠ {w}
                          </div>
                        ))}
                      </div>
                    );
                  })()}

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

                {m.role === "assistant" && <MessageFeedback message={m} />}
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
              disabled={loading || streaming}
              aria-label="Skriv en melding"
            />
            <button
              className="send-btn"
              onClick={() => void sendMessage(input)}
              disabled={loading || streaming || !input.trim()}
            >
              {loading || streaming ? "Sender …" : "Send"}
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
