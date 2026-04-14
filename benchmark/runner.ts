import { query } from "@anthropic-ai/claude-agent-sdk";
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

/**
 * Execute a single benchmark run: call the SDK `query()` with the arm
 * configuration, stream messages, track tokens, enforce timeout.
 */
export async function executeRun(config: ArmConfig): Promise<RunResult> {
  const tokens = new TokenAccumulator();
  const abortController = new AbortController();

  // Wall-clock timeout
  const timeout = setTimeout(() => {
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

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
        } else {
          return {
            status: "error",
            tokens: tokens.result(),
            error: `SDK error: ${msg.subtype}`,
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
