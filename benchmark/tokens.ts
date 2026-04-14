import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type TokenRecord = {
  parent_input: number;
  parent_output: number;
  subagent_input: number;
  subagent_output: number;
  total_cost_usd: number;
  wall_clock_ms: number;
};

/**
 * Accumulate token usage from an SDK message stream.
 *
 * Discrimination: SDKAssistantMessage has `parent_tool_use_id`.
 * - null → parent turn
 * - non-null → subagent turn
 *
 * The final SDKResultMessage has aggregate usage and cost.
 */
export class TokenAccumulator {
  private startTime = Date.now();
  parent_input = 0;
  parent_output = 0;
  subagent_input = 0;
  subagent_output = 0;
  total_cost_usd = 0;

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
      this.total_cost_usd = msg.total_cost_usd ?? 0;
    }
  }

  result(): TokenRecord {
    return {
      parent_input: this.parent_input,
      parent_output: this.parent_output,
      subagent_input: this.subagent_input,
      subagent_output: this.subagent_output,
      total_cost_usd: this.total_cost_usd,
      wall_clock_ms: Date.now() - this.startTime,
    };
  }
}
