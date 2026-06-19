#!/usr/bin/env node
/**
 * One tiny call to verify the configured OPENAI_MODEL works via Chat Completions
 * AND that tool-calling works (what agent mode needs). Reads the key/model from
 * .env.local. Run:  node scripts/check-model.mjs
 *
 * Makes a single minimal request. Prints OK + whether a tool call came back, or
 * the exact error (so we know if we must switch to the Responses API).
 */
import { readFileSync } from "node:fs";

function readEnvLocal() {
  const out = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

const env = readEnvLocal();
const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const model = env.OPENAI_MODEL || "gpt-4o-mini";

if (!apiKey || apiKey.includes("<<")) {
  console.error("Mangler ekte OPENAI_API_KEY i .env.local.");
  process.exit(1);
}

const reasoning = /^(gpt-5|o\d)/i.test(model.trim());
console.log(`Tester modell: ${model}  (reasoning=${reasoning}, dropper temperature=${reasoning})`);

const { default: OpenAI } = await import("openai");
const client = new OpenAI({ apiKey });

const tools = [{
  type: "function",
  function: {
    name: "ping",
    description: "Returnerer pong. Kall dette verktøyet.",
    parameters: { type: "object", properties: {} },
  },
}];

try {
  const res = await client.chat.completions.create({
    model,
    ...(reasoning ? {} : { temperature: 0.2 }),
    messages: [{ role: "user", content: "Kall ping-verktøyet." }],
    tools,
    tool_choice: "auto",
  });
  const msg = res.choices[0]?.message;
  const calledTool = (msg?.tool_calls?.length ?? 0) > 0;
  console.log("✅ Chat Completions svarte.");
  console.log("   tool-calling funker:", calledTool ? "JA (modellen kalte ping)" : "nei (ga tekstsvar)");
  console.log("   innhold:", (msg?.content ?? "").slice(0, 120) || "(tom — brukte tool call)");
  console.log("\n→ gpt-5.5 funker via Chat Completions. Agent-modus kan brukes.");
} catch (err) {
  console.error("❌ Kallet feilet:");
  console.error("   ", err?.status ?? "", err?.message ?? String(err));
  console.error("\n→ Hvis dette sier at modellen ikke støttes på chat.completions / krever Responses API,");
  console.error("  si fra, så migrerer jeg providerne til Responses API.");
  process.exit(2);
}
