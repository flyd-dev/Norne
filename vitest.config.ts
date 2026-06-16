import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Map the "@/..." path alias used across the app.
      "@": path.resolve(__dirname, "."),
      // `server-only` throws when imported outside an RSC server context;
      // stub it so server modules can be unit-tested.
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
});
