import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Task } from "./tasks.js";

const WORK_DIR = resolve(import.meta.dirname, "../.swebench-work");

/** Get the Docker image URI for a task using the same logic as the eval script. */
function getDockerImageUri(task: Task, dockerhubUsername: string): string {
  const [repoBase, repoNameOnly] = task.repo.toLowerCase().split("/");
  let hsh = task.instance_id.replace("instance_", "");
  let name = repoNameOnly;

  // Mirror the special-case logic from helper_code/image_uri.py
  if (
    task.instance_id ===
    "instance_element-hq__element-web-ec0f940ef0e8e3b61078f145f34dc40d1938e6c5-vnan"
  ) {
    name = "element-web";
  } else if (
    repoBase.includes("element-hq") &&
    repoNameOnly.includes("element-web")
  ) {
    name = "element";
    if (hsh.endsWith("-vnan")) hsh = hsh.slice(0, -5);
  } else if (hsh.endsWith("-vnan")) {
    hsh = hsh.slice(0, -5);
  }

  let tag = `${repoBase}.${name}-${hsh}`;
  if (tag.length > 128) tag = tag.slice(0, 128);
  return `${dockerhubUsername}/sweap-images:${tag}`;
}

/**
 * Prepare a local working directory for a task:
 * 1. Pull the Docker image (if not cached)
 * 2. Copy /app from the container to a local dir
 * 3. Checkout the base_commit
 *
 * Returns the path to the local repo directory.
 */
export function prepareWorkdir(
  task: Task,
  dockerhubUsername: string = "jefzda",
): string {
  const taskDir = resolve(WORK_DIR, task.instance_id);

  // If already prepared, just reset to base commit
  if (existsSync(resolve(taskDir, ".git"))) {
    execSync(`git checkout -f ${task.base_commit}`, {
      cwd: taskDir,
      stdio: "pipe",
    });
    execSync(`git clean -fdx`, { cwd: taskDir, stdio: "pipe" });
    return taskDir;
  }

  // Clean up any partial state
  if (existsSync(taskDir)) rmSync(taskDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });

  const imageUri = getDockerImageUri(task, dockerhubUsername);
  console.error(`[docker] Pulling ${imageUri}...`);
  execSync(`docker pull ${imageUri}`, { stdio: "pipe", timeout: 300_000 });

  // Create a temporary container and copy /app contents
  console.error(`[docker] Extracting /app to ${taskDir}...`);
  const containerId = execSync(`docker create ${imageUri}`, {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();

  try {
    execSync(`docker cp ${containerId}:/app/. ${taskDir}`, { stdio: "pipe" });
  } finally {
    execSync(`docker rm ${containerId}`, { stdio: "pipe" });
  }

  // Checkout base commit
  execSync(`git checkout -f ${task.base_commit}`, {
    cwd: taskDir,
    stdio: "pipe",
  });

  return taskDir;
}

/** Clean up a task's working directory. */
export function cleanWorkdir(task: Task): void {
  const taskDir = resolve(WORK_DIR, task.instance_id);
  if (existsSync(taskDir)) rmSync(taskDir, { recursive: true });
}

/** Reset a workdir to base_commit for a re-run. */
export function resetWorkdir(taskDir: string, baseCommit: string): void {
  execSync(`git checkout -f ${baseCommit}`, { cwd: taskDir, stdio: "pipe" });
  execSync(`git clean -fdx`, { cwd: taskDir, stdio: "pipe" });
}
