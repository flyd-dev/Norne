import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the orchestrator so the route is tested in isolation (no Firestore/OpenAI).
vi.mock("@/lib/chat/orchestrator", () => ({
  runChat: vi.fn(),
}));

import { POST } from "@/app/api/chat/route";
import { runChat } from "@/lib/chat/orchestrator";

const mockedRunChat = vi.mocked(runChat);

function postRequest(body: unknown, raw = false) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Valid REST-mode config so validateEnv passes for the non-validation tests.
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_API_KEY = "test-api-key";
  process.env.FIREBASE_AUTH_EMAIL = "test@example.com";
  process.env.FIREBASE_AUTH_PASSWORD = "test-password";
});

describe("POST /api/chat — input validation", () => {
  it("rejects an empty message with 400", async () => {
    const res = await POST(postRequest({ message: "" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("message");
    expect(mockedRunChat).not.toHaveBeenCalled();
  });

  it("rejects a missing message field with 400", async () => {
    const res = await POST(postRequest({ foo: "bar" }));
    expect(res.status).toBe(400);
    expect(mockedRunChat).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await POST(postRequest("not json", true));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("JSON");
  });
});

describe("POST /api/chat — success", () => {
  it("returns the orchestrator result with the new response shape", async () => {
    mockedRunChat.mockResolvedValueOnce({
      answer: "Vi har 3 prosjekter.",
      sources: ["projects"],
      dataUsed: { firestoreCollections: ["projects"], documents: [] },
      warnings: [],
    });
    const res = await POST(postRequest({ message: "Hvilke prosjekter har vi?" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.answer).toBe("Vi har 3 prosjekter.");
    expect(body.dataUsed.firestoreCollections).toEqual(["projects"]);
    expect(body.dataUsed.documents).toEqual([]);
    expect(body.warnings).toEqual([]);
  });
});

describe("POST /api/chat — error handling does not leak internals", () => {
  it("returns a generic 500 without exposing the internal error", async () => {
    const secret = "sk-SUPERSECRET-TOKEN-12345";
    mockedRunChat.mockRejectedValueOnce(new Error(`OpenAI failed with key ${secret}`));

    const res = await POST(postRequest({ message: "Hvilke prosjekter har vi?" }));
    const body = await res.json();
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(500);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("OpenAI failed");
    expect(body.error).toBe("Noe gikk galt under behandlingen av forespørselen.");
    expect(body.requestId).toBeTruthy();
  });
});
