import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLLMProvider } from "@/lib/llm";
import { validateEnv } from "@/lib/env";

const SAVED = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("LLM_") ||
      key.startsWith("OPENAI_") ||
      key.startsWith("OLLAMA_") ||
      key.startsWith("FIREBASE_")
    ) {
      delete process.env[key];
    }
  }
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  resetEnv();
  Object.assign(process.env, SAVED);
});

describe("getLLMProvider — factory selection", () => {
  it("selects the OpenAI provider when LLM_PROVIDER=openai", () => {
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test-dummy";
    expect(getLLMProvider().name).toBe("openai");
  });

  it("selects the Ollama provider when LLM_PROVIDER=ollama", () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1";
    expect(getLLMProvider().name).toBe("ollama");
  });

  it("defaults to OpenAI when LLM_PROVIDER is unset", () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy";
    expect(getLLMProvider().name).toBe("openai");
  });
});

describe("validateEnv — provider-aware requirements", () => {
  function setFirestoreRest() {
    process.env.FIREBASE_PROJECT_ID = "p";
    process.env.FIREBASE_API_KEY = "k";
    process.env.FIREBASE_AUTH_EMAIL = "e@x.no";
    process.env.FIREBASE_AUTH_PASSWORD = "pw";
  }

  it("does NOT require OPENAI_API_KEY when LLM_PROVIDER=ollama", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1";
    // No OPENAI_API_KEY set on purpose.
    const result = validateEnv();
    expect(result.llmProvider).toBe("ollama");
  });

  it("requires OLLAMA_MODEL when LLM_PROVIDER=ollama", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "ollama";
    expect(() => validateEnv()).toThrow(/OLLAMA_MODEL/);
  });

  it("treats OLLAMA_API_KEY as optional (validation passes without it)", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "llama3.1";
    // No OLLAMA_API_KEY set.
    expect(validateEnv().llmProvider).toBe("ollama");
  });

  it("never leaks the OLLAMA_API_KEY value in validation errors", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_API_KEY = "super-secret-ollama-token";
    // Missing OLLAMA_MODEL forces an error that mentions the missing var only.
    try {
      validateEnv();
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("OLLAMA_MODEL");
      expect(msg).not.toContain("super-secret-ollama-token");
    }
  });

  it("requires OPENAI_API_KEY when LLM_PROVIDER=openai", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "openai";
    expect(() => validateEnv()).toThrow(/OPENAI_API_KEY/);
  });

  it("rejects an unsupported LLM_PROVIDER", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "anthropic";
    expect(() => validateEnv()).toThrow(/Unsupported LLM_PROVIDER/);
  });

  it("error messages never include secret values", () => {
    setFirestoreRest();
    process.env.LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = ""; // missing
    try {
      validateEnv();
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("OPENAI_API_KEY");
      expect(msg).not.toContain("pw"); // the firestore password value
    }
  });
});
