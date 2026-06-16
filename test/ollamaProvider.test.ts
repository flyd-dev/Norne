import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaProvider } from "@/lib/llm/ollamaProvider";

const SAVED = { ...process.env };

function resetOllamaEnv() {
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_API_KEY;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetOllamaEnv();
  process.env.OLLAMA_MODEL = "llama3.1";
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ message: { content: "svar" } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOllamaEnv();
  Object.assign(process.env, SAVED);
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: url as string, init: init as RequestInit };
}

describe("createOllamaProvider", () => {
  it("uses the default localhost URL when OLLAMA_BASE_URL is missing", async () => {
    const provider = createOllamaProvider();
    await provider.generateAnswer({ systemPrompt: "s", userPrompt: "u", context: {} });
    expect(lastCall().url).toBe("http://localhost:11434/api/chat");
  });

  it("accepts a remote HTTPS URL", async () => {
    process.env.OLLAMA_BASE_URL = "https://ollama.example.com";
    const provider = createOllamaProvider();
    await provider.generateAnswer({ systemPrompt: "s", userPrompt: "u", context: {} });
    expect(lastCall().url).toBe("https://ollama.example.com/api/chat");
  });

  it("strips a trailing slash from a remote URL", async () => {
    process.env.OLLAMA_BASE_URL = "https://ollama.example.com/";
    const provider = createOllamaProvider();
    await provider.generateAnswer({ systemPrompt: "s", userPrompt: "u", context: {} });
    expect(lastCall().url).toBe("https://ollama.example.com/api/chat");
  });

  it("sends the Authorization header when OLLAMA_API_KEY is set", async () => {
    process.env.OLLAMA_API_KEY = "secret-token";
    const provider = createOllamaProvider();
    await provider.generateAnswer({ systemPrompt: "s", userPrompt: "u", context: {} });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
  });

  it("does NOT send the Authorization header when OLLAMA_API_KEY is missing", async () => {
    const provider = createOllamaProvider();
    await provider.generateAnswer({ systemPrompt: "s", userPrompt: "u", context: {} });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns the model's answer content", async () => {
    const provider = createOllamaProvider();
    const answer = await provider.generateAnswer({
      systemPrompt: "s",
      userPrompt: "u",
      context: {},
    });
    expect(answer).toBe("svar");
  });
});
