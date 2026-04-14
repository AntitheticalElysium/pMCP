import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { InboxManager } from "./inbox.js";
import { createAskTool, createNotifyTool } from "./tools.js";
import { createSubagentStartHook, createPreToolUseHook } from "./hooks.js";
import type { PmcpConfig, PmcpInstance, QueryRef, QueryWithSideQuestion } from "./types.js";

export function createPmcp(config?: PmcpConfig): PmcpInstance {
  const inbox = new InboxManager();
  const queryRef: QueryRef = { current: null };

  const askTool = createAskTool(queryRef);
  const notifyTool = createNotifyTool(queryRef, config?.notifyPrefix);

  const mcpServer = createSdkMcpServer({
    name: "pmcp",
    version: "0.1.0",
    tools: [askTool, notifyTool],
  });

  const subagentStartHook = createSubagentStartHook(inbox);
  const preToolUseHook = createPreToolUseHook(inbox);

  return {
    mcpServer,

    hooks: {
      SubagentStart: [subagentStartHook],
      PreToolUse: [preToolUseHook],
    },

    setQuery(query: Query): void {
      // Cast to access the private askSideQuestion method
      queryRef.current = query as QueryWithSideQuestion;
    },

    inject(agentId: string, message: string): void {
      inbox.push(agentId, message);
    },

    getAgentIds(): string[] {
      return inbox.getAgentIds();
    },
  };
}
