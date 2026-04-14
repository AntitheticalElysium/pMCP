import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { QueryRef } from "./types.js";

const DEFAULT_NOTIFY_PREFIX = "[NOTIFICATION FROM SUBAGENT]";

function getQuery(ref: QueryRef) {
  if (!ref.current) {
    throw new Error(
      "pmcp: query not bound yet. Call pmcp.setQuery(q) after creating the query.",
    );
  }
  return ref.current;
}

export function createAskTool(queryRef: QueryRef) {
  return tool(
    "ask",
    "Ask the parent agent a blocking question. Use this when you need clarification, want to confirm your approach, or need information from the parent's context. The parent sees its full conversation history when answering.",
    { question: z.string().describe("The question to ask the parent agent") },
    async ({ question }) => {
      const q = getQuery(queryRef);
      const result = await q.askSideQuestion(question);
      const text = result?.response ?? "No response from parent.";
      return { content: [{ type: "text", text }] };
    },
  );
}

export function createNotifyTool(
  queryRef: QueryRef,
  prefix: string = DEFAULT_NOTIFY_PREFIX,
) {
  return tool(
    "notify",
    "Send a non-blocking notification to the parent agent. Use this to report progress, flag discoveries, or signal intent. The parent receives the notification in real-time but you do not wait for a response.",
    {
      message: z
        .string()
        .describe("The notification message to send to the parent"),
    },
    async ({ message }) => {
      const q = getQuery(queryRef);
      // Fire-and-forget: don't await, don't block
      q.askSideQuestion(`${prefix}: ${message}`).catch(() => {});
      return { content: [{ type: "text", text: "Notified." }] };
    },
  );
}
