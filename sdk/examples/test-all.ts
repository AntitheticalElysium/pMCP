/**
 * Minimal integration test for all three pMCP primitives.
 *
 * Run with: npx tsx examples/test-all.ts
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPmcp } from "../src/index.js";

const pmcp = createPmcp();

const q = query({
  prompt: [
    "You have a background agent called 'worker'.",
    "Spawn it now, then wait for it to finish and report what it said.",
  ].join(" "),
  options: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 10,
    mcpServers: {
      pmcp: pmcp.mcpServer,
    },
    hooks: {
      SubagentStart: pmcp.hooks.SubagentStart,
      PreToolUse: pmcp.hooks.PreToolUse,
    },
    agents: {
      worker: {
        description: "A test worker that exercises pMCP communication",
        prompt: [
          "You are a test worker. Do exactly these steps in order:",
          "1. Use the 'notify' tool with message: 'Starting work'",
          "2. Use the 'ask' tool with question: 'What is 2+2?'",
          "3. Use the 'notify' tool with message: 'Got answer, finishing up'",
          "4. Return a summary of what happened, including the answer you received from ask.",
        ].join("\n"),
        tools: ["mcp__pmcp__ask", "mcp__pmcp__notify"],
        mcpServers: ["pmcp"],
        background: true,
      },
    },
  },
});

pmcp.setQuery(q);

// After a short delay, inject a message to test the inject primitive
setTimeout(() => {
  const agents = pmcp.getAgentIds();
  if (agents.length > 0) {
    console.log(`\n[TEST] Injecting message to agent: ${agents[0]}`);
    pmcp.inject(agents[0], "Injected context: the sky is blue.");
  }
}, 5000);

console.log("[TEST] Starting pMCP integration test...\n");

for await (const message of q) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`[PARENT] ${block.text}`);
      }
    }
  } else if (message.type === "system" && message.subtype === "notification") {
    console.log(`[NOTIFICATION] ${(message as any).text}`);
  }
}

console.log("\n[TEST] Done.");
