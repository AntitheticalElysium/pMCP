import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TokenAccumulator, type TokenRecord } from "./tokens.js";
import type { ArmConfig } from "./arms.js";

export type RunStatus = "resolved" | "failed" | "timeout" | "error";

export type RunResult = {
  status: RunStatus;
  tokens: TokenRecord;
  error?: string;
  resultText?: string;
};

const RUN_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

function logMsg(msg: SDKMessage) {
  if (msg.type === "assistant") {
    const usage = msg.message?.usage;
    const isSubagent = msg.parent_tool_use_id !== null;
    console.error(
      `    [sdk] assistant (${isSubagent ? "subagent" : "parent"}) in=${usage?.input_tokens ?? 0} out=${usage?.output_tokens ?? 0}`,
    );
  } else if (msg.type === "result") {
    console.error(`    [sdk] result: ${msg.subtype} cost=$${msg.total_cost_usd?.toFixed(4) ?? "?"} turns=${msg.num_turns}`);
  } else if (msg.type === "system") {
    const subtype = (msg as any).subtype;
    if (subtype) console.error(`    [sdk] system/${subtype}`);
  }
}

/**
 * Execute a single benchmark run: call the SDK `query()` with the arm
 * configuration, stream messages, track tokens, enforce timeout.
 */
export async function executeRun(config: ArmConfig): Promise<RunResult> {
  const tokens = new TokenAccumulator();
  const abortController = new AbortController();

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
      tokens.process(msg);
      logMsg(msg);

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
        } else {
          const errors = "errors" in msg ? (msg.errors as string[]).join("; ") : msg.subtype;
          return {
            status: "error",
            tokens: tokens.result(),
            error: `SDK error: ${errors}`,
          };
        }
      }
    }

    return {
      status: "failed", // Will be upgraded to "resolved" by the grader
      tokens: tokens.result(),
      resultText,
    };
  } catch (err: any) {
    if (abortController.signal.aborted) {
      return {
        status: "timeout",
        tokens: tokens.result(),
        error: "Wall-clock timeout (20 min)",
      };
    }
    return {
      status: "error",
      tokens: tokens.result(),
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
