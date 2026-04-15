import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSample, loadByIds } from "./tasks.js";
import { prepareWorkdir, resetWorkdir } from "./docker.js";
import { createArmConfig, type Arm } from "./arms.js";
import { executeRun } from "./runner.js";
import { capturePatch, savePatch, writeGraderJson } from "./patches.js";

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
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tasks" && args[i + 1]) opts.tasks = parseInt(args[++i]);
    else if (arg === "--runs" && args[i + 1]) opts.runs = parseInt(args[++i]);
    else if (arg === "--arms" && args[i + 1]) opts.arms = args[++i].split(",") as Arm[];
    else if (arg === "--model" && args[i + 1]) opts.model = args[++i];
    else if (arg === "--seed" && args[i + 1]) opts.seed = parseInt(args[++i]);
    else if (arg === "--task-ids" && args[i + 1]) opts.taskIds = args[++i].split(",");
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
  total_cost_usd: number;
  wall_clock_ms: number;
  num_turns: number;
  status: string;
  failure_reason: string | null;
  patch_path: string | null;
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

  // Initialize runs.jsonl
  writeFileSync(RUNS_PATH, "");

  // Run loop: task × arm × run
  let completed = 0;
  const total = tasks.length * opts.arms.length * opts.runs;

  for (const task of tasks) {
    const workdir = workdirs.get(task.instance_id)!;

    for (const arm of opts.arms) {
      for (let runIdx = 0; runIdx < opts.runs; runIdx++) {
        completed++;
        console.error(`\n[harness] [${completed}/${total}] ${task.instance_id} | Arm ${arm} | Run ${runIdx}`);

        // Reset workdir to base commit
        resetWorkdir(workdir, task.base_commit);

        // Build arm config
        const config = createArmConfig(arm, task, workdir, opts.model);

        // Execute
        const result = await executeRun(config);

        // Capture patch
        const patch = capturePatch(workdir, task.base_commit);
        const patchPath = patch.trim()
          ? savePatch(arm, task.instance_id, runIdx, patch)
          : null;

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
          total_cost_usd: result.tokens.total_cost_usd,
          wall_clock_ms: result.tokens.wall_clock_ms,
          num_turns: result.tokens.num_turns,
          status: result.status,
          failure_reason: result.error ?? null,
          patch_path: patchPath,
        };

        appendRun(log);

        console.error(`  Status: ${result.status} | Cost: $${result.tokens.total_cost_usd.toFixed(4)} | Turns: ${result.tokens.num_turns} | Tokens: ${result.tokens.total_input}in/${result.tokens.total_output}out | Time: ${(result.tokens.wall_clock_ms / 1000).toFixed(1)}s | Patch: ${patch.trim() ? "yes" : "no"}`);
      }
    }
  }

  // Write grader JSONs
  console.error("\n[harness] Writing grader input files...");
  for (const arm of opts.arms) {
    const path = writeGraderJson(arm, tasks, opts.runs);
    console.error(`  ${arm}: ${path}`);
  }

  console.error("\n[harness] Done. Run the grader:");
  console.error(`  cd ../SWE-bench_Pro-os`);
  console.error(`  python swe_bench_pro_eval.py \\`);
  console.error(`    --raw_sample_path=helper_code/sweap_eval_full_v2.jsonl \\`);
  console.error(`    --patch_path=../pMCP/benchmark/grader_input_A.json \\`);
  console.error(`    --output_dir=../pMCP/benchmark/grading_results \\`);
  console.error(`    --scripts_dir=run_scripts \\`);
  console.error(`    --num_workers=1 \\`);
  console.error(`    --dockerhub_username=jefzda \\`);
  console.error(`    --use_local_docker`);
}

main().catch((err) => {
  console.error("[harness] Fatal error:", err);
  process.exit(1);
});
