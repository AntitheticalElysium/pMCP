import type {
  HookCallbackMatcher,
  SubagentStartHookInput,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { InboxManager } from "./inbox.js";

export function createSubagentStartHook(
  inbox: InboxManager,
): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        const { agent_id } = input as SubagentStartHookInput;
        if (agent_id) {
          inbox.create(agent_id);
        }
        return { continue: true };
      },
    ],
  };
}

export function createPreToolUseHook(
  inbox: InboxManager,
): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        const { agent_id } = input as PreToolUseHookInput;
        if (!agent_id || !inbox.has(agent_id)) {
          return { continue: true };
        }

        const messages = inbox.drain(agent_id);
        if (messages.length === 0) {
          return { continue: true };
        }

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
}
