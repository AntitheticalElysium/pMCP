import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// --- State ---

type PendingAsk = {
  resolve: (answer: string) => void;
  question: string;
  timestamp: number;
};

const pendingAsks = new Map<string, PendingAsk>();
const inboxes = new Map<string, string[]>();
let askCounter = 0;

// --- Channel notification helper ---

function pushChannel(
  server: McpServer,
  content: string,
  meta: Record<string, string>,
) {
  // notifications/claude/channel is a custom notification method understood by Claude Code.
  // It's not in the MCP SDK's typed ServerNotification union, so we cast.
  (server.server as any).notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}

// --- MCP Server ---

const INSTRUCTIONS = `You have a parent-subagent communication system called pMCP.

When you see <channel source="pmcp"> events, they are messages from your subagents:

- **ASK events** (<channel source="pmcp" type="ask" request_id="...">):
  A subagent is blocked waiting for your answer. Call mcp__pmcp__respond to
  answer. If there's only one pending ask, request_id is optional. If there
  are multiple, the error will list them with their questions — use the
  matching request_id.

- **NOTIFY events** (<channel source="pmcp" type="notify">):
  Informational updates from subagents. No response needed. Use these to
  track progress and catch misalignment early.

To send a message to a running subagent, call mcp__pmcp__inject with the
agent's ID and your message. The message is delivered on the subagent's
next tool call.`;

const server = new McpServer(
  { name: "pmcp", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: INSTRUCTIONS,
  },
);

// --- Tool: ask ---

const ASK_TIMEOUT_MS = 120_000;

server.tool(
  "ask",
  "Ask the parent agent a blocking question. Use when you need clarification, want to confirm your approach, or need information from the parent's context. Your work pauses until the parent responds (timeout: 120s).",
  { question: z.string().describe("The question to ask the parent agent") },
  async ({ question }) => {
    const requestId = `req_${++askCounter}`;

    // Register the pending promise BEFORE pushing the channel notification.
    // This prevents a race where the parent calls respond before the promise is stored.
    const answerPromise = new Promise<string>((resolve) => {
      pendingAsks.set(requestId, { resolve, question, timestamp: Date.now() });
    });

    pushChannel(server, question, { type: "ask", request_id: requestId });

    // Race against timeout
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => {
        pendingAsks.delete(requestId);
        reject(new Error("ASK_TIMEOUT"));
      }, ASK_TIMEOUT_MS);
    });

    try {
      const answer = await Promise.race([answerPromise, timeoutPromise]);
      return { content: [{ type: "text" as const, text: answer }] };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: `ASK_TIMEOUT: Parent did not respond within 120 seconds. Question was: '${question}'. Proceed on your best judgment or abort.`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Tool: notify ---

server.tool(
  "notify",
  "Send a non-blocking notification to the parent agent. Use for progress updates, unexpected discoveries, or approach changes. Do NOT notify for every small step — batch routine progress.",
  {
    message: z
      .string()
      .describe("The notification message to send to the parent"),
  },
  async ({ message }) => {
    pushChannel(server, message, { type: "notify" });
    return { content: [{ type: "text" as const, text: "Notified." }] };
  },
);

// --- Tool: respond ---

server.tool(
  "respond",
  "Answer a pending ask from a subagent. If only one ask is pending, request_id is optional.",
  {
    request_id: z
      .string()
      .optional()
      .describe(
        "The request_id from the ask event. Optional if only one ask is pending.",
      ),
    answer: z.string().describe("Your answer to the subagent's question"),
  },
  async ({ request_id, answer }) => {
    // FIFO auto-matching
    if (!request_id) {
      if (pendingAsks.size === 0) {
        return {
          content: [
            { type: "text" as const, text: "No pending asks to respond to." },
          ],
          isError: true,
        };
      }
      if (pendingAsks.size === 1) {
        const [autoId, pending] = [...pendingAsks.entries()][0];
        pendingAsks.delete(autoId);
        pending.resolve(answer);
        return {
          content: [
            {
              type: "text" as const,
              text: `Delivered answer to ${autoId} ('${pending.question}').`,
            },
          ],
        };
      }
      // Multiple pending — error with listing
      const listing = [...pendingAsks.entries()]
        .map(([id, p]) => `${id} ('${p.question}')`)
        .join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Multiple pending asks. Specify request_id: ${listing}`,
          },
        ],
        isError: true,
      };
    }

    // Explicit request_id
    const pending = pendingAsks.get(request_id);
    if (!pending) {
      if (pendingAsks.size === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No pending ask with request_id '${request_id}'. No asks are currently pending.`,
            },
          ],
          isError: true,
        };
      }
      const listing = [...pendingAsks.entries()]
        .map(([id, p]) => `${id} ('${p.question}')`)
        .join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `No pending ask with request_id '${request_id}'. Current pending asks: ${listing}`,
          },
        ],
        isError: true,
      };
    }

    pendingAsks.delete(request_id);
    pending.resolve(answer);
    return {
      content: [
        {
          type: "text" as const,
          text: `Delivered answer to ${request_id} ('${pending.question}').`,
        },
      ],
    };
  },
);

// --- Tool: inject ---

server.tool(
  "inject",
  "Send a message to a running subagent. The message is delivered on the subagent's next tool call via the PreToolUse hook.",
  {
    agent_id: z.string().describe("The subagent's agent_id"),
    message: z.string().describe("The message to inject into the subagent"),
  },
  async ({ agent_id, message }) => {
    if (!inboxes.has(agent_id)) {
      inboxes.set(agent_id, []);
    }
    inboxes.get(agent_id)!.push(message);
    return {
      content: [
        {
          type: "text" as const,
          text: `Message queued for agent ${agent_id}. Will be delivered on its next tool call.`,
        },
      ],
    };
  },
);

// --- HTTP Server for PreToolUse hook ---

const HTTP_PORT = 8799;

function handleCheckInject(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const input = JSON.parse(body);
      const agentId: string | undefined = input.agent_id;

      if (!agentId || !inboxes.has(agentId)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }

      const inbox = inboxes.get(agentId)!;
      if (inbox.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }

      // Drain inbox
      const messages = inbox.splice(0, inbox.length);
      const response = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `[MESSAGE FROM PARENT]: ${messages.join("\n")}`,
        },
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
    }
  });
}

const httpServer = createServer((req, res) => {
  if (req.url === "/check-inject") {
    handleCheckInject(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- Startup ---

async function main() {
  // Start HTTP server for inject hook
  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    // Log to stderr so it doesn't interfere with stdio MCP transport
    console.error(`[pmcp] inject hook server listening on 127.0.0.1:${HTTP_PORT}`);
  });

  // Connect MCP server to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[pmcp] MCP server connected via stdio");
}

main().catch((err) => {
  console.error("[pmcp] Fatal error:", err);
  process.exit(1);
});
