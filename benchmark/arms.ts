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

const DELEGATION_SUFFIX_PMCP = `\nDelegate implementation work to the worker subagent. You coordinate and verify. The worker will communicate with you via ask/notify — respond to asks promptly. When the worker notifies you of findings or approach, your response will be relayed back to the worker, so use it to course-correct, confirm the approach, or provide additional context. Keep your final summary concise (under 200 words).`;

// ---------------------------------------------------------------------------
// Worker subagent definition
// ---------------------------------------------------------------------------

const WORKER_PROMPT = `You are a software engineering subagent. You explore, implement, and test code changes delegated by a parent agent.

Your job: carry out the task delegated by the parent agent. Read the relevant code, make changes, and run tests to verify. Report your findings clearly.

When you're done, summarize what you changed and why.`;

const WORKER_PMCP_SUFFIX = `

You have two communication tools — \`ask\` and \`notify\` — for talking with the parent agent. You MUST use them as part of your workflow:

1. **After initial exploration**, notify the parent with what you found: which files are relevant, where the bug or issue is, and what approach you plan to take. Example: notify("The issue is in src/controllers/users.js:142 — the filter predicate doesn't account for deleted users. I plan to add a status check before the comparison.")

2. **Before committing to a non-obvious approach**, ask the parent to confirm. This is critical when you find multiple candidate fixes, conflicting patterns in the codebase, or when the fix might have side effects. Example: ask("I found two places this could be fixed — in the query builder (cleaner) or in the controller (safer). The query builder approach changes shared code that 3 other endpoints use. Which do you prefer?")

3. **When you discover something unexpected**, notify immediately. Example: notify("The failing test expects behavior X, but the issue description implies Y. There may be a contradiction — proceeding with what the test expects.")

These tools let you leverage the parent's broader context about the task and repository. The parent can see things you can't — use that. Do NOT skip communication and work in isolation.`;

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

export type PmcpStats = {
  asks: number;
  notifies: number;
  injects: number;
  ask_questions: string[];
  ask_responses: string[];
  notify_messages: string[];
  inject_responses: string[];
};

function createPmcpState(): PmcpState & { stats: PmcpStats } {
  const queryRef: { current: any } = { current: null };
  const inboxes = new Map<string, string[]>();
  const stats: PmcpStats = { asks: 0, notifies: 0, injects: 0, ask_questions: [], ask_responses: [], notify_messages: [], inject_responses: [] };
  // Track the most recent worker agent_id for inject-on-notify
  let activeAgentId: string | null = null;

  const askTool = tool(
    "ask",
    "Ask the parent agent a blocking question. Use when you need clarification or information from the parent's context.",
    { question: z.string().describe("The question to ask the parent agent") },
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
    "Send a non-blocking notification to the parent agent. Use for progress updates or unexpected discoveries.",
    {
      message: z
        .string()
        .describe("The notification message to send to the parent"),
    },
    async ({ message }) => {
      stats.notifies++;
      stats.notify_messages.push(message);
      const q = queryRef.current;
      if (!q) {
        return { content: [{ type: "text" as const, text: "Notified." }] };
      }
      // Fire-and-forget from worker's perspective: notify returns immediately.
      // Parent sees the notification via askSideQuestion. If the parent responds
      // (e.g. course correction), that response is injected into the worker's
      // inbox and delivered on its next tool call via the PreToolUse hook.
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

  // Hooks for inject delivery
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
