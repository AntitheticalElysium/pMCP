import type {
  Query,
  HookCallbackMatcher,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Query with access to the private askSideQuestion method.
 * askSideQuestion exists at runtime on the Query object but is not
 * in the public type declarations. It sends a sidechain model call
 * against the parent's full conversation context.
 */
export type QueryWithSideQuestion = Query & {
  askSideQuestion(
    question: string,
  ): Promise<{ response: string; synthetic: boolean } | null>;
};

/** Mutable ref to hold the Query object after it's created */
export type QueryRef = { current: QueryWithSideQuestion | null };

export type PmcpConfig = {
  /** Prefix for notification messages. Default: "[NOTIFICATION FROM SUBAGENT]" */
  notifyPrefix?: string;
};

export type PmcpInstance = {
  /** SDK MCP server config — pass to options.mcpServers */
  mcpServer: McpSdkServerConfigWithInstance;

  /** Hook definitions — merge into options.hooks */
  hooks: {
    SubagentStart: HookCallbackMatcher[];
    PreToolUse: HookCallbackMatcher[];
  };

  /** Bind the Query object after query() is called */
  setQuery(query: Query): void;

  /** Push a message into a running subagent's inbox */
  inject(agentId: string, message: string): void;

  /** Get all known agent IDs (populated as subagents start) */
  getAgentIds(): string[];
};
