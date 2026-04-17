import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TokenAccumulator, type TokenRecord } from "./tokens.js";
import type { ArmConfig, PmcpStats } from "./arms.js";

export type RunStatus = "resolved" | "failed" | "timeout" | "error";

export type RunResult = {
  status: RunStatus;
  tokens: TokenRecord;
  error?: string;
  resultText?: string;
  transcript: TranscriptEntry[];
  pmcpStats?: PmcpStats;
};

export type TranscriptEntry = {
  type: string;
  subtype?: string;
  is_subagent: boolean;
  tool_name?: string;
  tool_input_summary?: string;
  text_preview?: string;
  input_tokens?: number;
  output_tokens?: number;
  timestamp_ms: number;
};

const RUN_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

function buildTranscriptEntry(msg: SDKMessage, startTime: number): TranscriptEntry | null {
  if (msg.type === "assistant") {
    const usage = msg.message?.usage;
    const isSubagent = msg.parent_tool_use_id !== null;
    const content = msg.message?.content;

    // Extract tool calls and text from content blocks
    let toolName: string | undefined;
    let toolInputSummary: string | undefined;
    let textPreview: string | undefined;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          toolName = block.name;
          const input = block.input as any;
          if (input) {
            // Summarize tool input (first 200 chars)
            const summary = typeof input === "string" ? input : JSON.stringify(input);
            toolInputSummary = summary.slice(0, 200);
          }
        } else if (block.type === "text" && block.text) {
          textPreview = block.text.slice(0, 300);
        }
      }
    }

    console.error(
      `    [sdk] assistant (${isSubagent ? "subagent" : "parent"}) in=${usage?.input_tokens ?? 0} out=${usage?.output_tokens ?? 0}`,
    );

    return {
      type: "assistant",
      is_subagent: isSubagent,
      tool_name: toolName,
      tool_input_summary: toolInputSummary,
      text_preview: textPreview,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      timestamp_ms: Date.now() - startTime,
    };
  } else if (msg.type === "result") {
    console.error(`    [sdk] result: ${msg.subtype} cost=$${msg.total_cost_usd?.toFixed(4) ?? "?"} turns=${msg.num_turns}`);
    return {
      type: "result",
      subtype: msg.subtype,
      is_subagent: false,
      timestamp_ms: Date.now() - startTime,
    };
  } else if (msg.type === "system") {
    const subtype = (msg as any).subtype;
    if (subtype) console.error(`    [sdk] system/${subtype}`);
    return {
      type: "system",
      subtype,
      is_subagent: false,
      timestamp_ms: Date.now() - startTime,
    };
  }
  return null;
}

/**
 * Execute a single benchmark run: call the SDK `query()` with the arm
 * configuration, stream messages, track tokens, enforce timeout.
 */
export async function executeRun(config: ArmConfig): Promise<RunResult> {
  const tokens = new TokenAccumulator();
  const abortController = new AbortController();
  const transcript: TranscriptEntry[] = [];
  const startTime = Date.now();

  // Wall-clock timeout
  const timeout = setTimeout(() => {
    console.error("    [sdk] *** TIMEOUT — aborting ***");
    abortController.abort();
  }, RUN_TIMEOUT_MS);

  try {
    const q = query({
      prompt: config.prompt,
      options: {
        ...config.options,
        abortController,
      },
    });

    // For arm C, bind the query object so pMCP tools can call askSideQuestion
    if (config.bindQuery) {
      config.bindQuery(q);
    }

    let resultText: string | undefined;

    for await (const msg of q) {
      // Manual timeout check — the SDK iterator may not honor AbortController
      if (abortController.signal.aborted) break;

      tokens.process(msg);
      const entry = buildTranscriptEntry(msg, startTime);
      if (entry) transcript.push(entry);

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
        } else {
          const errors = "errors" in msg ? (msg.errors as string[]).join("; ") : (msg as any).subtype;
          return {
            status: "error",
            tokens: tokens.result(),
            error: `SDK error: ${errors}`,
            transcript,
            pmcpStats: config.getPmcpStats?.(),
          };
        }
      }
    }

    // If we broke out due to abort, treat as timeout
    if (abortController.signal.aborted) {
      return {
        status: "timeout",
        tokens: tokens.result(),
        error: "Wall-clock timeout (20 min)",
        transcript,
        pmcpStats: config.getPmcpStats?.(),
      };
    }

    return {
      status: "failed", // Will be upgraded to "resolved" by the grader
      tokens: tokens.result(),
      resultText,
      transcript,
      pmcpStats: config.getPmcpStats?.(),
    };
  } catch (err: any) {
    if (abortController.signal.aborted) {
      return {
        status: "timeout",
        tokens: tokens.result(),
        error: "Wall-clock timeout (20 min)",
        transcript,
        pmcpStats: config.getPmcpStats?.(),
      };
    }
    return {
      status: "error",
      tokens: tokens.result(),
      error: err?.message ?? String(err),
      transcript,
      pmcpStats: config.getPmcpStats?.(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
