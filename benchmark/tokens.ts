import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type ModelUsageRecord = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};

export type TokenRecord = {
  parent_input: number;
  parent_output: number;
  subagent_input: number;
  subagent_output: number;
  total_input: number;
  total_output: number;
  cache_read_input: number;
  cache_creation_input: number;
  total_cost_usd: number;
  wall_clock_ms: number;
  num_turns: number;
  model_usage: Record<string, ModelUsageRecord>;
};

/**
 * Accumulate token usage from an SDK message stream.
 *
 * Per-message assistant tokens are streaming deltas — small and unreliable
 * for parent/subagent breakdown. We still accumulate them for relative
 * proportions, but the authoritative totals come from SDKResultMessage.usage
 * which has the real aggregate.
 */
export class TokenAccumulator {
  private startTime = Date.now();
  parent_input = 0;
  parent_output = 0;
  subagent_input = 0;
  subagent_output = 0;
  total_input = 0;
  total_output = 0;
  cache_read_input = 0;
  cache_creation_input = 0;
  total_cost_usd = 0;
  num_turns = 0;
  model_usage: Record<string, ModelUsageRecord> = {};

  process(msg: SDKMessage): void {
    if (msg.type === "assistant") {
      const usage = msg.message?.usage;
      if (!usage) return;

      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;

      if (msg.parent_tool_use_id === null) {
        this.parent_input += input;
        this.parent_output += output;
      } else {
        this.subagent_input += input;
        this.subagent_output += output;
      }
    }

    if (msg.type === "result") {
      // Authoritative totals from the result message
      this.total_cost_usd = msg.total_cost_usd ?? 0;
      this.num_turns = msg.num_turns ?? 0;

      const usage = msg.usage;
      if (usage) {
        this.total_input = usage.input_tokens ?? 0;
        this.total_output = usage.output_tokens ?? 0;
        this.cache_read_input = (usage as any).cache_read_input_tokens ?? 0;
        this.cache_creation_input = (usage as any).cache_creation_input_tokens ?? 0;
      }

      // Capture per-model usage breakdown
      const modelUsage = (msg as any).modelUsage;
      if (modelUsage && typeof modelUsage === "object") {
        for (const [model, mu] of Object.entries(modelUsage)) {
          const u = mu as any;
          this.model_usage[model] = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
            costUSD: u.costUSD ?? 0,
          };
        }
      }
    }
  }

  result(): TokenRecord {
    return {
      parent_input: this.parent_input,
      parent_output: this.parent_output,
      subagent_input: this.subagent_input,
      subagent_output: this.subagent_output,
      total_input: this.total_input,
      total_output: this.total_output,
      cache_read_input: this.cache_read_input,
      cache_creation_input: this.cache_creation_input,
      total_cost_usd: this.total_cost_usd,
      wall_clock_ms: Date.now() - this.startTime,
      num_turns: this.num_turns,
      model_usage: this.model_usage,
    };
  }
}
