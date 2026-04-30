import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSample, loadByIds } from "./tasks.js";
import { prepareWorkdir, resetWorkdir } from "./docker.js";
import { createArmConfig, type Arm } from "./arms.js";
import { executeRun } from "./runner.js";
import type { RunResult } from "./runner.js";
import { capturePatch, savePatch, writeGraderJson } from "./patches.js";
import { countTokens } from "@anthropic-ai/tokenizer";

const MAX_RETRIES = 2;

const USAGE_LIMIT_PATTERNS = [
  "out of extra usage",
  "credit balance is too low",
  "rate limit",
  "usage limit",
];

function isUsageLimitError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return USAGE_LIMIT_PATTERNS.some(p => lower.includes(p));
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    tasks: 3,
    runs: 1,
    arms: ["A", "B", "C"] as Arm[],
    model: "claude-sonnet-4-6",
    seed: 42,
    taskIds: null as string[] | null,
    resume: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tasks" && args[i + 1]) opts.tasks = parseInt(args[++i]);
    else if (arg === "--runs" && args[i + 1]) opts.runs = parseInt(args[++i]);
    else if (arg === "--arms" && args[i + 1]) opts.arms = args[++i].split(",") as Arm[];
    else if (arg === "--model" && args[i + 1]) opts.model = args[++i];
    else if (arg === "--seed" && args[i + 1]) opts.seed = parseInt(args[++i]);
    else if (arg === "--task-ids" && args[i + 1]) opts.taskIds = args[++i].split(",");
    else if (arg === "--task-file" && args[i + 1]) {
      const content = readFileSync(args[++i], "utf-8");
      opts.taskIds = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    }
    else if (arg === "--resume") opts.resume = true;
    else if (arg === "--fresh") opts.taskIds = opts.taskIds; // handled below
  }
  // --fresh flag: clear runs.jsonl before starting
  if (args.includes("--fresh")) {
    writeFileSync(resolve(import.meta.dirname, "runs.jsonl"), "");
  }

  return opts;
}

// ---------------------------------------------------------------------------
// JSONL logging
// ---------------------------------------------------------------------------

type RunLog = {
  task_id: string;
  arm: Arm;
  run_idx: number;
  resolved: boolean | null; // null = pending grading
  parent_tokens_in: number;
  parent_tokens_out: number;
  subagent_tokens_in: number;
  subagent_tokens_out: number;
  total_input: number;
  total_output: number;
  cache_read_input: number;
  cache_creation_input: number;
  total_cost_usd: number;
  wall_clock_ms: number;
  num_turns: number;
  status: string;
  retries: number;
  failure_reason: string | null;
  patch_path: string | null;
  model_usage: Record<string, any>;
  pmcp_asks: number;
  pmcp_notifies: number;
  max_parent_context: number;
  max_subagent_context: number;
};

const RUNS_PATH = resolve(import.meta.dirname, "runs.jsonl");

function appendRun(log: RunLog) {
  appendFileSync(RUNS_PATH, JSON.stringify(log) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  console.error(`[harness] Config: ${opts.tasks} tasks × ${opts.arms.join(",")} arms × ${opts.runs} runs = ${opts.tasks * opts.arms.length * opts.runs} total runs`);
  console.error(`[harness] Model: ${opts.model}, Seed: ${opts.seed}`);

  // Load tasks
  const tasks = opts.taskIds
    ? loadByIds(opts.taskIds)
    : loadSample(opts.tasks, opts.seed);

  if (tasks.length === 0) {
    console.error("[harness] No tasks loaded!");
    process.exit(1);
  }

  console.error(`[harness] Loaded ${tasks.length} tasks from ${new Set(tasks.map((t) => t.repo)).size} repos`);
  for (const t of tasks) {
    console.error(`  - ${t.instance_id} (${t.repo})`);
  }

  // Prepare Docker workdirs
  console.error("\n[harness] Preparing Docker workdirs...");
  const workdirs = new Map<string, string>();
  for (const task of tasks) {
    const dir = prepareWorkdir(task);
    workdirs.set(task.instance_id, dir);
    console.error(`  ✓ ${task.instance_id}`);
  }

  // Ensure runs.jsonl exists (append mode — never overwrite previous results)
  if (!existsSync(RUNS_PATH)) writeFileSync(RUNS_PATH, "");

  // Load completed runs for --resume
  const completedRuns = new Set<string>();
  if (opts.resume) {
    const lines = readFileSync(RUNS_PATH, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Skip usage-limited entries — they need to be retried
        if (isUsageLimitError(entry.failure_reason)) continue;
        completedRuns.add(`${entry.task_id}|${entry.arm}|${entry.run_idx}`);
      } catch { }
    }
    if (completedRuns.size > 0) {
      console.error(`[harness] Resuming — ${completedRuns.size} runs already completed, skipping those`);
    }
  }

  // Run loop: task × arm × run
  let completed = 0;
  const total = tasks.length * opts.arms.length * opts.runs;

  for (const task of tasks) {
    const workdir = workdirs.get(task.instance_id)!;

    for (const arm of opts.arms) {
      for (let runIdx = 0; runIdx < opts.runs; runIdx++) {
        completed++;
        const runKey = `${task.instance_id}|${arm}|${runIdx}`;
        if (completedRuns.has(runKey)) {
          console.error(`\n[harness] [${completed}/${total}] ${task.instance_id} | Arm ${arm} | Run ${runIdx} — SKIPPED (already completed)`);
          continue;
        }
        console.error(`\n[harness] [${completed}/${total}] ${task.instance_id} | Arm ${arm} | Run ${runIdx}`);

        let result: RunResult | undefined;
        let patch = "";
        let patchPath: string | null = null;
        let attempt = 0;
        let contextSizes: { agent_id: string | null, tokens: number }[] = [];

        while (attempt <= MAX_RETRIES) {
          if (attempt > 0) {
            console.error(`  [retry ${attempt}/${MAX_RETRIES}] Re-attempting after 0-turn failure...`);
          }

          // Reset workdir to base commit
          resetWorkdir(workdir, task.base_commit);

          // Build arm config (fresh per attempt — pMCP state must reset)
          const config = createArmConfig(arm, task, workdir, opts.model);

          // Add precise token tracking via hook
          contextSizes = []; // Reset on retry
          const tokenTrackingHook = {
            hooks: [
              async (input: any) => {
                try {
                  if (input.transcript_path) {
                    const str = readFileSync(input.transcript_path, "utf-8");
                    const numTokens = countTokens(str);
                    contextSizes.push({
                      agent_id: input.agent_id || null,
                      tokens: numTokens
                    });
                  }
                } catch (e) { }
                return { continue: true };
              }
            ]
          };

          if (!config.options.hooks) config.options.hooks = {};
          if (!config.options.hooks.PreToolUse) config.options.hooks.PreToolUse = [];
          config.options.hooks.PreToolUse.push(tokenTrackingHook);

          // Execute
          result = await executeRun(config);

          // Usage limit — stop the entire harness immediately
          if (isUsageLimitError(result.error)) break;

          // If we got real work done (>0 turns), accept the result
          if (result.tokens.num_turns > 0 || result.status === "error") break;

          attempt++;
        }

        if (!result) break; // should never happen

        // Usage limit — don't log, stop harness
        if (isUsageLimitError(result.error)) {
          console.error(`\n[harness] *** USAGE LIMIT HIT: ${result.error} ***`);
          console.error(`[harness] Stopping. Re-run with --resume to continue when usage resets.`);
          // Write grader JSONs for whatever we completed so far
          console.error("\n[harness] Writing grader input files for completed runs...");
          for (const a of opts.arms) {
            writeGraderJson(a, tasks, opts.runs);
          }
          process.exit(2);
        }

        // Capture patch
        patch = capturePatch(workdir, task.base_commit);
        patchPath = patch.trim()
          ? savePatch(arm, task.instance_id, runIdx, patch)
          : null;

        // Save transcript
        const logDir = resolve(import.meta.dirname, "logs", arm, task.instance_id);
        mkdirSync(logDir, { recursive: true });
        const transcriptPath = resolve(logDir, `${runIdx}.jsonl`);
        writeFileSync(
          transcriptPath,
          result.transcript.map((e) => JSON.stringify(e)).join("\n") + "\n",
        );

        // pMCP stats
        const pmcpStats = result.pmcpStats;

        // Log
        const log: RunLog = {
          task_id: task.instance_id,
          arm,
          run_idx: runIdx,
          resolved: null,
          parent_tokens_in: result.tokens.parent_input,
          parent_tokens_out: result.tokens.parent_output,
          subagent_tokens_in: result.tokens.subagent_input,
          subagent_tokens_out: result.tokens.subagent_output,
          total_input: result.tokens.total_input,
          total_output: result.tokens.total_output,
          cache_read_input: result.tokens.cache_read_input,
          cache_creation_input: result.tokens.cache_creation_input,
          total_cost_usd: result.tokens.total_cost_usd,
          wall_clock_ms: result.tokens.wall_clock_ms,
          num_turns: result.tokens.num_turns,
          status: result.status,
          retries: attempt,
          failure_reason: result.error ?? null,
          patch_path: patchPath,
          model_usage: result.tokens.model_usage,
          pmcp_asks: pmcpStats?.asks ?? 0,
          pmcp_notifies: pmcpStats?.notifies ?? 0,
          max_parent_context: contextSizes.filter((c: any) => !c.agent_id).reduce((max: number, c: any) => Math.max(max, c.tokens), 0),
          max_subagent_context: contextSizes.filter((c: any) => c.agent_id).reduce((max: number, c: any) => Math.max(max, c.tokens), 0),
        };

        appendRun(log);

        // Save pMCP detail log if any usage
        if (pmcpStats && (pmcpStats.asks > 0 || pmcpStats.notifies > 0)) {
          const pmcpLogPath = resolve(logDir, `${runIdx}.pmcp.json`);
          writeFileSync(pmcpLogPath, JSON.stringify(pmcpStats, null, 2));
        }

        console.error(`  Status: ${result.status} | Cost: $${result.tokens.total_cost_usd.toFixed(4)} | Turns: ${result.tokens.num_turns} | Tokens: ${result.tokens.total_input}in/${result.tokens.total_output}out (cache_read: ${result.tokens.cache_read_input}, cache_create: ${result.tokens.cache_creation_input}) | Time: ${(result.tokens.wall_clock_ms / 1000).toFixed(1)}s | Patch: ${patch.trim() ? "yes" : "no"}`);
        for (const [model, mu] of Object.entries(result.tokens.model_usage)) {
          console.error(`    Model ${model}: in=${mu.inputTokens} out=${mu.outputTokens} cache_read=${mu.cacheReadInputTokens} cache_create=${mu.cacheCreationInputTokens} cost=$${mu.costUSD.toFixed(4)}`);
        }
        if (pmcpStats) {
          console.error(`    pMCP: ${pmcpStats.asks} asks, ${pmcpStats.notifies} notifies, ${pmcpStats.injects} injects`);
        }
      }
    }
  }

  // Write grader JSONs — one file per (arm, run)
  console.error("\n[harness] Writing grader input files...");
  const graderFiles: string[] = [];
  for (const arm of opts.arms) {
    const paths = writeGraderJson(arm, tasks, opts.runs);
    for (const p of paths) {
      console.error(`  ${arm}: ${p}`);
      graderFiles.push(p);
    }
  }

  console.error("\n[harness] Done. Run the grader for each file:");
  for (const gf of graderFiles) {
    const basename = gf.split("/").pop()!;
    const resultsDir = basename.replace(".json", "").replace("grader_input_", "grading_results_");
    console.error(`\n  cd ../SWE-bench_Pro-os`);
    console.error(`  python swe_bench_pro_eval.py \\`);
    console.error(`    --raw_sample_path=helper_code/sweap_eval_full_v2.jsonl \\`);
    console.error(`    --patch_path=../pMCP/benchmark/${basename} \\`);
    console.error(`    --output_dir=../pMCP/benchmark/${resultsDir} \\`);
    console.error(`    --scripts_dir=run_scripts \\`);
    console.error(`    --num_workers=1 \\`);
    console.error(`    --dockerhub_username=jefzda \\`);
    console.error(`    --use_local_docker`);
  }
}

main().catch((err) => {
  console.error("[harness] Fatal error:", err);
  process.exit(1);
});
