import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Task = {
  instance_id: string;
  repo: string;
  repo_name: string;
  base_commit: string;
  problem_statement: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  image_name: string;
};

const EVAL_REPO = resolve(import.meta.dirname, "../../SWE-bench_Pro-os");
const DATASET_PATH = resolve(EVAL_REPO, "helper_code/sweap_eval_full_v2.jsonl");

/** Load all 731 instances from the JSONL dataset. */
export function loadAll(): Task[] {
  const lines = readFileSync(DATASET_PATH, "utf-8").trim().split("\n");
  return lines.map(parseLine);
}

/** Load specific instances by ID. */
export function loadByIds(ids: string[]): Task[] {
  const idSet = new Set(ids);
  return loadAll().filter((t) => idSet.has(t.instance_id));
}

/** Load a random stratified sample: pick `count` tasks spread across repos. */
export function loadSample(count: number, seed?: number): Task[] {
  const all = loadAll();

  // Group by repo
  const byRepo = new Map<string, Task[]>();
  for (const t of all) {
    if (!byRepo.has(t.repo)) byRepo.set(t.repo, []);
    byRepo.get(t.repo)!.push(t);
  }

  // Seeded PRNG (simple LCG)
  let s = seed ?? Date.now();
  const rand = () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  // Shuffle each repo's tasks
  for (const tasks of byRepo.values()) {
    for (let i = tasks.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
    }
  }

  // Round-robin across repos until we have enough
  const repos = [...byRepo.keys()].sort();
  const result: Task[] = [];
  let idx = 0;
  while (result.length < count) {
    let added = false;
    for (const repo of repos) {
      if (result.length >= count) break;
      const tasks = byRepo.get(repo)!;
      if (idx < tasks.length) {
        result.push(tasks[idx]);
        added = true;
      }
    }
    if (!added) break; // exhausted all repos
    idx++;
  }

  return result;
}

function parseLine(line: string): Task {
  const raw = JSON.parse(line);
  return {
    instance_id: raw.instance_id,
    repo: raw.repo,
    repo_name: raw.repo_name ?? "",
    base_commit: raw.base_commit,
    problem_statement: raw.problem_statement,
    fail_to_pass: Array.isArray(raw.FAIL_TO_PASS)
      ? raw.FAIL_TO_PASS
      : JSON.parse(raw.FAIL_TO_PASS),
    pass_to_pass: Array.isArray(raw.PASS_TO_PASS)
      ? raw.PASS_TO_PASS
      : JSON.parse(raw.PASS_TO_PASS),
    image_name: raw.image_name,
  };
}
