/**
 * Pluggable text-embeddings provider for semantic document search.
 *
 * Mirrors the LLM provider pattern (lib/llm): the backend is selected from
 * EMBEDDINGS_PROVIDER and the rest of the RAG layer only depends on the
 * `embedTexts` / `embedQuery` functions below — so the store and search code
 * never care which model produced the vectors.
 *
 *   - "ollama" (default): free + local. POST {baseUrl}/api/embed (batch).
 *   - "openai": cheap hosted fallback via the OpenAI SDK.
 *
 * All vectors are L2-normalised to unit length, so a plain L2 distance in the
 * vector store ranks identically to cosine similarity (cosineSim = 1 - d²/2).
 *
 * Server-side only — never import from client code.
 */

import "server-only";
import { env } from "@/lib/env";

/** Normalise a vector to unit length (no-op for a zero vector). */
function normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

async function embedWithOllama(texts: string[]): Promise<number[][]> {
  const baseUrl = env.ollama.baseUrl().replace(/\/+$/, "");
  const model = env.rag.embeddingsModel();
  const apiKey = env.ollama.apiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings request failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { embeddings?: number[][]; error?: string };
  if (data.error || !Array.isArray(data.embeddings)) {
    throw new Error("Ollama returned an invalid embeddings response.");
  }
  return data.embeddings.map(normalize);
}

/** Max attempts when Voyage rate-limits (429) or has a transient 5xx. */
const VOYAGE_MAX_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedWithVoyage(texts: string[]): Promise<number[][]> {
  const baseUrl = env.voyage.baseUrl().replace(/\/+$/, "");
  const apiKey = env.voyage.apiKey();
  const model = env.rag.embeddingsModel();

  let res: Response | undefined;
  for (let attempt = 1; attempt <= VOYAGE_MAX_ATTEMPTS; attempt++) {
    res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (res.ok) break;
    // Retry on rate limit / transient server errors, honouring Retry-After.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === VOYAGE_MAX_ATTEMPTS) {
      throw new Error(`Voyage embeddings request failed (HTTP ${res.status}).`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** (attempt - 1), 30_000); // 1s,2s,4s,…capped 30s
    await sleep(waitMs);
  }

  const data = (await res!.json()) as {
    data?: { embedding: number[]; index: number }[];
  };
  if (!Array.isArray(data.data)) {
    throw new Error("Voyage returned an invalid embeddings response.");
  }
  // Voyage returns items with an explicit index; sort to guarantee input order.
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => normalize(d.embedding));
}

async function embedWithOpenAI(texts: string[]): Promise<number[][]> {
  // Imported lazily so the SDK only loads when this provider is actually used.
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: env.openai.apiKey() });
  const res = await client.embeddings.create({
    model: env.rag.embeddingsModel(),
    input: texts,
  });
  return res.data.map((d) => normalize(d.embedding));
}

/** True when semantic search is configured (provider not "none"). */
export function embeddingsEnabled(): boolean {
  return env.rag.embeddingsProvider() !== "none";
}

/**
 * Embed a batch of texts → unit vectors (one per input, same order).
 * Throws if EMBEDDINGS_PROVIDER is "none".
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = env.rag.embeddingsProvider();
  switch (provider) {
    case "voyage":
      return embedWithVoyage(texts);
    case "ollama":
      return embedWithOllama(texts);
    case "openai":
      return embedWithOpenAI(texts);
    case "none":
      throw new Error(
        "Embeddings are disabled (EMBEDDINGS_PROVIDER=none). Enable a provider " +
          "to use semantic document search.",
      );
  }
}

/** Embed a single query string → one unit vector. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec;
}
