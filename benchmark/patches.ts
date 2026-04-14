import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Arm } from "./arms.js";

const PATCHES_DIR = resolve(import.meta.dirname, "patches");

/**
 * Capture `git diff` from a workdir after a run.
 * Returns the patch string (empty if no changes).
 */
export function capturePatch(workdir: string, baseCommit: string): string {
  try {
    return execSync(`git diff ${baseCommit}`, {
      cwd: workdir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  } catch {
    return "";
  }
}

/** Save a patch to disk for logging. */
export function savePatch(
  arm: Arm,
  taskId: string,
  runIdx: number,
  patch: string,
): string {
  const dir = resolve(PATCHES_DIR, arm, taskId);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${runIdx}.diff`);
  writeFileSync(path, patch);
  return path;
}

/**
 * Grader input entry format.
 * The eval script accepts both `patch` and `model_patch` keys.
 */
type GraderEntry = {
  instance_id: string;
  patch: string;
  prefix: string;
};

/**
 * Build the grader JSON from all saved patches.
 * Uses the best run per (arm, task) — the first non-empty patch.
 */
export function buildGraderInput(
  arm: Arm,
  tasks: { instance_id: string }[],
  runsPerTask: number,
): GraderEntry[] {
  const entries: GraderEntry[] = [];

  for (const task of tasks) {
    let bestPatch = "";
    for (let r = 0; r < runsPerTask; r++) {
      const path = resolve(PATCHES_DIR, arm, task.instance_id, `${r}.diff`);
      if (existsSync(path)) {
        const patch = readFileSync(path, "utf-8");
        if (patch.trim()) {
          bestPatch = patch;
          break;
        }
      }
    }
    entries.push({
      instance_id: task.instance_id,
      patch: bestPatch,
      prefix: `pmcp_${arm}`,
    });
  }

  return entries;
}

/** Write grader JSON file for a specific arm. */
export function writeGraderJson(
  arm: Arm,
  tasks: { instance_id: string }[],
  runsPerTask: number,
): string {
  const entries = buildGraderInput(arm, tasks, runsPerTask);
  const outPath = resolve(import.meta.dirname, `grader_input_${arm}.json`);
  writeFileSync(outPath, JSON.stringify(entries, null, 2));
  return outPath;
}
