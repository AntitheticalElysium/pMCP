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

const DELEGATION_SUFFIX_PMCP = `\n\nYou are responsible for coordinating the task and ensuring the quality of the fix. You have full access to the environment tools (Bash, Read, Write), but you should delegate implementation, exploration, and test execution to the worker subagent to preserve your context window. Monitor the worker's progress via their notifications. If the worker asks for help or is stuck, use your tools to provide the necessary information or verification. Do not accept a task as complete until the worker has provided explicit evidence (e.g., test logs, code snippets) confirming the fix. Reject any summary that lacks proof.`;

// ---------------------------------------------------------------------------
// Worker subagent definition
// ---------------------------------------------------------------------------

const WORKER_PROMPT = `You are a software engineering subagent. You explore, implement, and test code changes delegated by a parent agent.

Your job: carry out the task delegated by the parent agent. Read the relevant code, make changes, and run tests to verify. Report your findings clearly.

When you're done, summarize what you changed and why.`;

const WORKER_PMCP_SUFFIX = `

You have two communication tools — \`ask\` and \`notify\` — for talking with the parent agent. You MUST use them as part of your workflow:

1. **Evidence-based reporting**: When you notify the parent or ask for help, do not just summarize. You MUST provide the raw evidence you are looking at (e.g., the specific error message, the bash output of a failing test, or the code snippet you are analyzing). The parent cannot see your terminal or the files you have read unless you share them.

2. **Initial Exploration**: After finding the root cause, notify the parent with the raw evidence and your proposed plan.

3. **Confirming Approach**: Ask the parent to confirm non-obvious approaches, especially when the fix might have side effects or when you find conflicting patterns in the codebase.

4. **Unexpected Discoveries**: Notify immediately if you find contradictions between the issue description and the actual code or test behavior.`;

const workerAgent: AgentDefinition = {
  description: "General-purpose subagent for code exploration, implementation, and testing",
  prompt: WORKER_PROMPT,
  background: true,
};

const workerAgentWithPmcp: AgentDefinition = {
  ...workerAgent,
  prompt: WORKER_PROMPT + WORKER_PMCP_SUFFIX,
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

export type PmcpStats = {
  asks: number;
  notifies: number;
  injects: number;
  ask_questions: string[];
  ask_responses: string[];
  notify_messages: string[];
  inject_responses: string[];
  context_history: { agent_id: string | null; chars: number; timestamp_ms: number }[];
};

function createPmcpState(): PmcpState & { stats: PmcpStats } {
  const queryRef: { current: any } = { current: null };
  const inboxes = new Map<string, string[]>();
  const stats: PmcpStats = { 
    asks: 0, 
    notifies: 0, 
    injects: 0, 
    ask_questions: [], 
    ask_responses: [], 
    notify_messages: [], 
    inject_responses: [],
    context_history: []
  };
  // Track the most recent worker agent_id for inject-on-notify
  let activeAgentId: string | null = null;
  const startTime = Date.now();

  const askTool = tool(
    "ask",
    "Ask the parent agent a blocking question. Use when you need clarification, confirmation, or information from the parent's context. Always include the raw code or error logs you are asking about.",
    { question: z.string().describe("The question to ask the parent agent, including relevant raw evidence.") },
    async ({ question }) => {
      stats.asks++;
      stats.ask_questions.push(question);
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
      stats.ask_responses.push(text);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const notifyTool = tool(
    "notify",
    "Send a non-blocking notification to the parent agent. Use for progress updates, plan confirmation, or unexpected discoveries. Include raw evidence.",
    {
      message: z
        .string()
        .describe("The notification message, including relevant raw evidence."),
    },
    async ({ message }) => {
      stats.notifies++;
      stats.notify_messages.push(message);
      const q = queryRef.current;
      if (!q) {
        return { content: [{ type: "text" as const, text: "Notified." }] };
      }
      q.askSideQuestion(`[NOTIFICATION FROM SUBAGENT]: ${message}`)
        .then((result: any) => {
          const response = result?.response;
          if (response && activeAgentId && inboxes.has(activeAgentId)) {
            inboxes.get(activeAgentId)!.push(response);
            stats.injects++;
            stats.inject_responses.push(response);
          }
        })
        .catch(() => {});
      return { content: [{ type: "text" as const, text: "Notified." }] };
    },
  );

  const mcpServer = createSdkMcpServer({
    name: "pmcp",
    version: "0.1.0",
    tools: [askTool, notifyTool],
  });

  // Hooks for inject delivery and context tracking
  const subagentStartHook: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        const { agent_id } = input as SubagentStartHookInput;
        if (agent_id) {
          inboxes.set(agent_id, []);
          activeAgentId = agent_id;
        }
        return { continue: true };
      },
    ],
  };

  const preToolUseHook: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        const { agent_id, transcript_path } = input as PreToolUseHookInput & { transcript_path?: string };
        
        // Track context size
        if (transcript_path && typeof transcript_path === "string") {
            try {
                const content = await import("node:fs/promises").then(fs => fs.readFile(transcript_path, "utf-8"));
                stats.context_history.push({
                    agent_id: agent_id ?? null,
                    chars: content.length,
                    timestamp_ms: Date.now() - startTime
                });
            } catch (e) {
                console.error(`[pmcp] Failed to read transcript for context tracking: ${e}`);
            }
        }

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
    stats,
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
  /** For arm C: retrieve pMCP usage stats after run */
  getPmcpStats?: () => PmcpStats;
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
        prompt: BASE_PROMPT(task) + DELEGATION_SUFFIX_PMCP,
        options: {
          ...baseOptions,
          agents: { worker: workerAgentWithPmcp },
          mcpServers: { pmcp: pmcp.mcpServer },
          hooks: pmcp.hooks,
        },
        bindQuery: (q) => {
          pmcp.queryRef.current = q;
        },
        getPmcpStats: () => pmcp.stats,
      };
    }
  }
}
