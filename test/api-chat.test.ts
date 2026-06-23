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
  // Anthropic is the default provider, so its key must be present.
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
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

describe("POST /api/chat — streaming ({ stream: true })", () => {
  it("emits token events then a done event as newline-delimited JSON", async () => {
    // The mocked orchestrator streams two chunks via onToken, then resolves.
    mockedRunChat.mockImplementationOnce(async (_m, _r, _h, opts) => {
      opts?.onToken?.("Hei ");
      opts?.onToken?.("verden");
      return {
        answer: "Hei verden",
        sources: ["x"],
        dataUsed: { firestoreCollections: [], documents: [] },
        warnings: [],
        route: "conversation",
      };
    });

    const res = await POST(postRequest({ message: "skriv noe", stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    const events = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(events).toEqual([
      { type: "token", text: "Hei " },
      { type: "token", text: "verden" },
      expect.objectContaining({ type: "done", answer: "Hei verden", route: "conversation" }),
    ]);
  });
});

describe("POST /api/chat — optional history (follow-ups)", () => {
  beforeEach(() => {
    mockedRunChat.mockResolvedValue({
      answer: "ok",
      sources: [],
      dataUsed: { firestoreCollections: [], documents: [] },
      warnings: [],
    });
  });

  it("still accepts the old { message } shape (no history)", async () => {
    const res = await POST(postRequest({ message: "Hei" }));
    expect(res.status).toBe(200);
    expect(mockedRunChat).toHaveBeenCalledWith("Hei", expect.any(String), [], {});
  });

  it("passes valid recent history through to the orchestrator", async () => {
    await POST(
      postRequest({
        message: "sjekk den",
        history: [
          { role: "user", content: "Har vi kapasitet i august?" },
          { role: "assistant", content: "Jeg mangler info." },
        ],
      }),
    );
    expect(mockedRunChat).toHaveBeenCalledWith(
      "sjekk den",
      expect.any(String),
      [
        { role: "user", content: "Har vi kapasitet i august?" },
        { role: "assistant", content: "Jeg mangler info." },
      ],
      {},
    );
  });

  it("ignores malformed history entries without failing the request", async () => {
    const res = await POST(
      postRequest({
        message: "sjekk den",
        history: [
          { role: "bogus", content: "x" },
          { role: "user", content: "" },
          { role: "user", content: "Gyldig melding" },
          "not an object",
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(mockedRunChat).toHaveBeenCalledWith(
      "sjekk den",
      expect.any(String),
      [{ role: "user", content: "Gyldig melding" }],
      {},
    );
  });

  it("keeps only the last 6 history messages", async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    await POST(postRequest({ message: "sjekk den", history }));
    const passed = mockedRunChat.mock.calls.at(-1)![2] as { content: string }[];
    expect(passed.length).toBe(6);
    expect(passed[0].content).toBe("m4");
    expect(passed[5].content).toBe("m9");
  });

  it("never logs message or history content", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secretMsg = "SECRET-MESSAGE-BODY";
    const secretHist = "SECRET-HISTORY-BODY";
    await POST(
      postRequest({
        message: secretMsg,
        history: [{ role: "user", content: secretHist }],
      }),
    );
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .join(" ");
    expect(logged).not.toContain(secretMsg);
    expect(logged).not.toContain(secretHist);
    logSpy.mockRestore();
    errSpy.mockRestore();
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
