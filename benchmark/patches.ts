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
 * Build the grader JSON for a single run index.
 * Each run is graded independently so we get per-run resolved rates.
 */
export function buildGraderInput(
  arm: Arm,
  tasks: { instance_id: string }[],
  runIdx: number,
): GraderEntry[] {
  const entries: GraderEntry[] = [];

  for (const task of tasks) {
    let patch = "";
    const path = resolve(PATCHES_DIR, arm, task.instance_id, `${runIdx}.diff`);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      if (content.trim()) {
        patch = content;
      }
    }
    entries.push({
      instance_id: task.instance_id,
      patch,
      prefix: `pmcp_${arm}`,
    });
  }

  return entries;
}

/**
 * Write grader JSON files for a specific arm — one file per run index.
 * Returns the list of paths written.
 */
export function writeGraderJson(
  arm: Arm,
  tasks: { instance_id: string }[],
  runsPerTask: number,
): string[] {
  const paths: string[] = [];

  for (let r = 0; r < runsPerTask; r++) {
    const entries = buildGraderInput(arm, tasks, r);
    const outPath = resolve(import.meta.dirname, `grader_input_${arm}_run${r}.json`);
    writeFileSync(outPath, JSON.stringify(entries, null, 2));
    paths.push(outPath);
  }

  return paths;
}
