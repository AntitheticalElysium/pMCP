import {
  createSdkMcpServer,
  tool,
  type AgentDefinition,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type Options,
  type PreToolUseHookInput,
  type SubagentStartHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { Task } from "./tasks.js";

export type Arm = "A" | "B" | "C";

// ---------------------------------------------------------------------------
// Task prompt
// ---------------------------------------------------------------------------

const BASE_PROMPT = (task: Task) => `You are working in a git repository. Your task is to fix an issue.

Repository: ${task.repo}

Issue description:
${task.problem_statement}

Failing tests:
${task.fail_to_pass.join("\n")}

Fix the issue so that the failing tests pass without breaking existing tests.
Do not modify test files.`;

const DELEGATION_SUFFIX = `\nDelegate implementation work to the worker subagent. You coordinate and verify.`;

// ---------------------------------------------------------------------------
// Worker subagent definition
// ---------------------------------------------------------------------------

const WORKER_PROMPT = `You are a general-purpose software engineering subagent. You can explore, implement, and test code.

Your job: carry out the task delegated by the parent agent. Read the relevant code, make changes, and run tests to verify. Report your findings clearly.

When you're done, summarize what you changed and why.`;

const WORKER_PMCP_SUFFIX = `

You have access to two communication tools for talking with the parent agent. Use \`ask\` when you need information you don't have and a decision depends on it — for example, when the task is ambiguous, when you find conflicting code patterns, or when you're not sure if your approach matches what the parent wants. Use \`notify\` to surface discoveries the parent should know about without waiting — for example, "this change will also affect module X" or "I found that the actual bug is in a different file than expected." These are real communication channels, not a rubber stamp. Use them as you would with a senior engineer who delegated this task to you.`;

const workerAgent: AgentDefinition = {
  description: "General-purpose subagent for code exploration, implementation, and testing",
  prompt: WORKER_PROMPT,
  background: true,
};

const workerAgentWithPmcp: AgentDefinition = {
  ...workerAgent,
  prompt: WORKER_PROMPT + WORKER_PMCP_SUFFIX,
  // pMCP tools will be added via the MCP server
};

// ---------------------------------------------------------------------------
// pMCP SDK integration for Arm C
// ---------------------------------------------------------------------------

type PmcpState = {
  mcpServer: McpServerConfig;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Reference to be bound to the Query object after creation */
  queryRef: { current: any };
  inboxes: Map<string, string[]>;
};

function createPmcpState(): PmcpState {
  const queryRef: { current: any } = { current: null };
  const inboxes = new Map<string, string[]>();

  const askTool = tool(
    "ask",
    "Ask the parent agent a blocking question. Use when you need clarification or information from the parent's context.",
    { question: z.string().describe("The question to ask the parent agent") },
    async ({ question }) => {
      const q = queryRef.current;
      if (!q) {
        return {
          content: [
            { type: "text" as const, text: "Error: query not bound yet." },
          ],
          isError: true,
        };
      }
      const result = await q.askSideQuestion(question);
      const text = result?.response ?? "No response from parent.";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const notifyTool = tool(
    "notify",
    "Send a non-blocking notification to the parent agent. Use for progress updates or unexpected discoveries.",
    {
      message: z
        .string()
        .describe("The notification message to send to the parent"),
    },
    async ({ message }) => {
      const q = queryRef.current;
      if (!q) {
        return { content: [{ type: "text" as const, text: "Notified." }] };
      }
      q.askSideQuestion(`[NOTIFICATION FROM SUBAGENT]: ${message}`).catch(
        () => {},
      );
      return { content: [{ type: "text" as const, text: "Notified." }] };
    },
  );

  const mcpServer = createSdkMcpServer({
    name: "pmcp",
    version: "0.1.0",
    tools: [askTool, notifyTool],
  });

  // Hooks for inject delivery
  const subagentStartHook: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        const { agent_id } = input as SubagentStartHookInput;
        if (agent_id) inboxes.set(agent_id, []);
        return { continue: true };
      },
    ],
  };

  const preToolUseHook: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        const { agent_id } = input as PreToolUseHookInput;
        if (!agent_id || !inboxes.has(agent_id)) return { continue: true };
        const inbox = inboxes.get(agent_id)!;
        if (inbox.length === 0) return { continue: true };
        const messages = inbox.splice(0, inbox.length);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            additionalContext: `[MESSAGE FROM PARENT]: ${messages.join("\n")}`,
          },
        };
      },
    ],
  };

  return {
    mcpServer,
    hooks: {
      SubagentStart: [subagentStartHook],
      PreToolUse: [preToolUseHook],
    },
    queryRef,
    inboxes,
  };
}

// ---------------------------------------------------------------------------
// Arm config factory
// ---------------------------------------------------------------------------

export type ArmConfig = {
  arm: Arm;
  prompt: string;
  options: Options;
  /** For arm C: bind this to the Query after creation */
  bindQuery?: (q: any) => void;
};

export function createArmConfig(
  arm: Arm,
  task: Task,
  cwd: string,
  model: string,
): ArmConfig {
  const baseOptions: Options = {
    cwd,
    model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 200,
    persistSession: false,
  };

  switch (arm) {
    case "A":
      return {
        arm,
        prompt: BASE_PROMPT(task),
        options: {
          ...baseOptions,
          disallowedTools: ["Agent"],
        },
      };

    case "B":
      return {
        arm,
        prompt: BASE_PROMPT(task) + DELEGATION_SUFFIX,
        options: {
          ...baseOptions,
          agents: { worker: workerAgent },
        },
      };

    case "C": {
      const pmcp = createPmcpState();
      return {
        arm,
        prompt: BASE_PROMPT(task) + DELEGATION_SUFFIX,
        options: {
          ...baseOptions,
          agents: { worker: workerAgentWithPmcp },
          mcpServers: { pmcp: pmcp.mcpServer },
          hooks: pmcp.hooks,
        },
        bindQuery: (q) => {
          pmcp.queryRef.current = q;
        },
      };
    }
  }
}
