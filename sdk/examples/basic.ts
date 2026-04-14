/**
 * Basic pMCP example — demonstrates ask, notify, and inject.
 *
 * Run with: npx tsx examples/basic.ts
 * Requires: ANTHROPIC_API_KEY environment variable
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createPmcp } from "../src/index.js";

const pmcp = createPmcp();

const q = query({
  prompt: [
    "You have a background research agent available.",
    "Spawn the 'researcher' agent to investigate the current directory.",
    "After it finishes, summarize what it found.",
  ].join(" "),
  options: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      pmcp: pmcp.mcpServer,
    },
    hooks: {
      SubagentStart: pmcp.hooks.SubagentStart,
      PreToolUse: pmcp.hooks.PreToolUse,
    },
    agents: {
      researcher: {
        description: "Explores the codebase and reports findings",
        prompt: [
          "You are a research agent with access to communication tools.",
          "Use the 'notify' tool to report your progress as you work.",
          "Use the 'ask' tool if you need clarification from the parent.",
          "Explore the current directory structure and summarize what you find.",
        ].join(" "),
        tools: [
          "Read",
          "Glob",
          "Grep",
          "Bash",
          "mcp__pmcp__ask",
          "mcp__pmcp__notify",
        ],
        mcpServers: ["pmcp"],
        background: true,
      },
    },
  },
});

pmcp.setQuery(q);

for await (const message of q) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
  }
}
