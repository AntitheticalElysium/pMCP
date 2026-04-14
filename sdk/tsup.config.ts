import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  external: [
    "@anthropic-ai/claude-agent-sdk",
    "@modelcontextprotocol/sdk",
    "zod",
  ],
});
