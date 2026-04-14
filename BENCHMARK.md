# pMCP Benchmark Specification
 
## Goal
 
Measure whether pMCP improves Claude Code subagent performance on a credible, contamination-free coding benchmark, and produce two publishable findings:
 
1. **Does Claude Code's native subagent feature help vs. single-agent mode?** (No prior art on this for Pro — independently publishable.)
2. **Does pMCP improve on vanilla subagents?** (The main result.)
 
## Why this benchmark, why these decisions
 
**Target benchmark: SWE-bench Pro public set** (the 11 GPL repos on HuggingFace, ~731 tasks).
 
Rationale, in order of importance:
 
- **SWE-bench Verified is unusable.** It is saturated (top models 77-81%), contaminated (OpenAI's audit found every frontier model could reproduce verbatim gold patches; OpenAI has stopped reporting Verified scores), and its tasks are too small to need delegation (median 4-line fix). Three arms would cluster at the ceiling and we'd measure noise.
- **Pro has headroom and matches our failure mode.** Top Pro scores are ~46-57%. Tasks average 107 lines across 4.1 files — substantive, multi-file work. Scale AI's failure analysis found that **context overflow is the dominant failure mode for the strongest models, accounting for 35.6% of Sonnet 4 failures**. Coding agents spend 60%+ of their time searching for context. This is exactly what pMCP targets.
- **Pro is contamination-free by design.** Built from GPL repos with legal barriers to inclusion in proprietary training corpora, plus a held-out private set.
- **There is a clean reference class.** Morph's WarpGrep v2 (RL-trained search subagent) is a published scaffolding intervention on Pro: adds 2.1-2.2 points across models, cuts Opus 4.6 cost by 15.6% and time by 28%. pMCP slots into the same reference class — scaffolding intervention attacking context overflow on Pro — with a different mechanism (bidirectional dialogue vs. better retrieval).
 
## Three arms
 
All arms use the **same model** (Sonnet 4.5 or 4.6, see below), the **same task prompts**, and the **same wall-clock cap**. The only thing that varies is the agent configuration.
 
| Arm | Config |
|---|---|
| **A. Single-agent baseline** | Claude Code main session. No custom subagents defined. No delegation. The parent does everything itself. |
| **B. Vanilla subagents** | Claude Code with custom subagents defined (see "Subagent definitions" below). Subagents are invoked **explicitly** via test prompt language. |
| **C. pMCP subagents** | Identical to B, plus pMCP installed and the `ask`/`notify`/`inject`/`respond` tools available to the subagents. Subagent system prompts include pMCP usage guidance (see below). |
 
**Critical: explicit invocation.** Auto-routing to custom subagents is unreliable in Claude Code — multiple sources confirm Claude often handles tasks in the main session even when a defined agent matches. Test prompts in arms B and C must explicitly tell Claude to use the subagent ("Use the implementer subagent to..."). Otherwise variance in routing will swamp signal from the actual intervention.
 
## Model choice
 
**Sonnet 4.5 (or 4.6 if compatible with the harness).** Reasons:
 
1. **Cost.** Opus is ~5x Sonnet. At Sonnet pricing, the full benchmark fits in $60-150 and lets you afford 5 runs per task. At Opus pricing it's $300-500 and you're stuck at 3 runs.
2. **Cleaner signal.** Anthropic's own prompt engineering docs flag that **Opus over-spawns subagents** — it delegates when a direct approach would be faster. This means Opus's subagent arm could look better than its single-agent arm for the wrong reason. Sonnet doesn't have this confound.
3. **Better story.** "I made the cheap default model meaningfully better with $0 of scaffolding" beats "I made the expensive flagship marginally better."
 
If Sonnet results are positive, run a small Opus follow-up (5-10 tasks, 3 runs each) as a "does it scale up" sidebar in the post. If Sonnet results are flat, *then* try Opus to test whether the issue is model capability vs. pMCP design.
 
## Sample size and runs
 
- **Tasks:** 20-25 tasks from the SWE-bench Pro public set, stratified by repository and difficulty (don't pick all from one repo, don't pick all easy or all hard).
- **Runs per task per arm:** 5 minimum. Variance is the enemy here. Single-shot agent benchmarks are near-meaningless.
- **Total runs:** 20 tasks × 3 arms × 5 runs = **300 runs**.
- **Budget:** $80-180 expected at Sonnet pricing. Set a hard ceiling at $300.
 
**Stratification rule for task selection:** Use Scale AI's repository and difficulty metadata. Aim for at least 5 distinct repositories and a mix of bug-fix vs. feature-addition tasks. Do not select tasks based on whether they "look good for delegation" — that's the bias we're trying to avoid.
 
## Metrics
 
**Two metrics. Resist adding more for v1.**
 
1. **Resolved rate** (binary, automatic). A task is resolved iff Scale AI's grader marks it resolved — both fail-to-pass tests now pass and pass-to-pass tests still pass. Use the official grader, not a homemade one.
2. **Total tokens** (parent + all subagents combined). See "Token instrumentation" below — this is a real engineering problem, not a setting.
 
**Do not add for v1:** wall-clock time, number of tool calls, number of asks per task, subjective quality judgments, "lines changed correctly." These are all interesting but they are observability data, not headline metrics. Collect them in logs if cheap, but the post chart is resolved-rate × tokens (a 2D scatter, one point per arm).
 
**Manual spot-check:** Hand-review 20% of "passing" runs to catch test-gaming (where the agent makes the test pass without actually fixing the issue). This is what serious agent papers do now. Note the spot-check rate in the writeup.
 
## Subagent definitions
 
For arms B and C, define subagents in `.claude/agents/`. Start with a minimal set — adding more is a future iteration, not v1. Initial set:
 
- **`explorer`** — read-only codebase exploration. Tools: Read, Grep, Glob. No Edit, no Write, no Bash. Job: find the relevant files and report what they contain.
- **`implementer`** — code modification. Tools: Read, Edit, Write, Bash (for running tests). Job: make the code change requested by the parent.
- **`tester`** — test execution and analysis. Tools: Read, Bash. Job: run the test suite and report what passed/failed.
 
The exact prompt content matters and the coding agent should iterate on it. Initial system prompt template for each: 4-8 sentences describing the role, the expected input shape from the parent, and the expected output shape. No more.
 
**For arm C, append a pMCP usage paragraph to each subagent's system prompt:**
 
> You have access to four communication tools for talking with the parent agent. Use `ask` when you need information you don't have and a decision depends on it — for example, when the task is ambiguous, when you find conflicting code patterns, or when you're not sure if your approach matches what the parent wants. Use `notify` to surface discoveries the parent should know about without waiting — for example, "this change will also affect module X" or "I found that the actual bug is in a different file than expected." These are real communication channels, not a rubber stamp. Use them as you would with a senior engineer who delegated this task to you.
 
The exact wording will need iteration. The coding agent should treat this paragraph as a versioned artifact and log which version was used per run.
 
## Test prompt format
 
Each task gets a single prompt sent to Claude Code. Same prompt across all three arms. Template:
 
```
Task: <SWE-bench Pro task description>
 
Repository: <repo path>
Failing tests: <list of fail-to-pass tests>
 
[ARM B AND C ONLY:]
Use the explorer subagent to identify the relevant files. Then use the implementer subagent to make the necessary changes. Use the tester subagent to verify that the failing tests now pass.
```
 
The bracketed delegation instruction is the only difference between arms. Arm A omits it entirely.
 
## Token instrumentation
 
Claude Code has **no native per-subagent token observability**. This is a real engineering problem the coding agent must solve. Three options, in order of preference:
 
1. **Hook-based instrumentation.** Use `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse` hooks to log token usage at lifecycle events. The hook input includes usage data. Aggregate per-run.
2. **API log parsing.** If running Claude Code in a mode that logs raw API calls, parse the logs for token counts. More fragile but more accurate.
3. **Output stream wrapping.** Wrap stdout/stderr and parse the streamed messages for usage data. Most fragile.
 
The coding agent should pick (1) if the hook output is sufficient and fall back to (2) if not. Either way, every run must produce a `(parent_input_tokens, parent_output_tokens, subagent_input_tokens, subagent_output_tokens)` tuple.
 
## Failure mode handling
 
Agent runs fail in two distinct ways and we must distinguish them:
 
- **Task failure** — the agent ran cleanly but didn't solve the task. Counts toward the resolved-rate metric as a failure.
- **Infrastructure failure** — Docker error, OOM, wedged subagent, network timeout, harness crash. Does **not** count toward the resolved-rate metric. Retry up to 2 times; if still failing, drop the run from the dataset and note it.
 
**Wall-clock cap:** 20 minutes per run. After 20 minutes, kill the process and treat as task failure (not infra failure). This prevents wedged subagents from burning the weekend.
 
**pMCP-specific failure modes to watch:**
- Subagent calls `ask`, parent never calls `respond`, subagent hangs forever. With the timeout fix already in pMCP this should be a structured error, not a hang. Verify in dry-run.
- Concurrent ask request_id mismatch. Should be fixed by the disambiguation work already done. Verify in dry-run.
- Context compaction eats an ASK channel event before parent responds. Known limitation. If it happens, log it but don't retry.
 
## Five unknowns to resolve before writing the harness
 
These are blockers for the coding agent to investigate first:
 
1. **Can SWE-bench Pro run on Arthur's laptop?** Each task spawns a Docker container with the full repo and dependencies. 32GB RAM is fine for orchestration but disk is the question — 41 repos × build artifacts × Docker layers could be 50-200GB. If too large, rent a small cloud box (Hetzner, DigitalOcean) for the run. Check Scale AI's setup docs and estimate before committing to local.
2. **What does Scale AI's SWE-Agent harness expect as the agent interface?** The Pro grader expects an agent that takes a task and produces a patch. Claude Code is not a drop-in for that. Three options: (a) write a Claude-Code-as-SWE-Agent adapter, (b) run Claude Code natively and feed its output to Scale's grader scripts manually, (c) skip the SWE-Agent harness entirely and use just the Pro dataset + grading scripts. Option (c) is probably easiest and still credible — the dataset and grader are what matter for credibility, not the harness wrapper.
3. **How are tokens counted across parent + subagents in Claude Code?** See "Token instrumentation" above. Coding agent should prototype hook-based logging on a single run before scaling.
4. **Does explicit subagent invocation work reliably?** Test on 2-3 sample tasks before launching the full benchmark. If the parent ignores the explicit invocation language and handles the task itself, the test prompt needs revision.
5. **Does pMCP work end-to-end inside the SWE-bench task environment?** pMCP has been tested in standalone Claude Code sessions but not inside a benchmark harness with Docker, time pressure, and unfamiliar codebases. Run one full pipeline (single task, all three arms, single run each) before launching the full sweep. Expect to find 5+ infrastructure bugs in this first pipeline. That is normal and the reason this step exists.
 
## Output artifacts
 
The harness should produce:
 
- **`runs.jsonl`** — one line per run with `{task_id, arm, run_idx, resolved, parent_tokens_in, parent_tokens_out, subagent_tokens_in, subagent_tokens_out, wall_clock_seconds, failure_reason, log_path}`.
- **`logs/<arm>/<task_id>/<run_idx>/`** — full conversation log per run, for failure analysis and spot-checks.
- **`results.md`** — aggregated table: per-arm resolved rate (mean ± std across runs), per-arm total tokens (mean), 2D scatter of (resolved rate, tokens) with one point per arm.
- **`failures.md`** — every infrastructure failure, with reason and whether it was retried successfully.
 
## Sequencing
 
1. **Resolve the five unknowns.** Don't start building the harness until questions 1-2 are answered. They determine the architecture.
2. **Build the harness on one task, all three arms, one run each.** This is the dry-run pipeline. Find and fix infrastructure bugs.
3. **Pilot run: 3 tasks × 3 arms × 3 runs = 27 runs.** Sanity-check the metrics, the logs, the failure handling, and the cost projection. If the pilot looks good, proceed.
4. **Full run: 20 tasks × 3 arms × 5 runs = 300 runs.** Let it run. Expect 12-24 hours of wall clock depending on parallelism.
5. **Aggregate and spot-check.** Generate `results.md`. Hand-review 20% of "passing" runs.
6. **Hand back to Arthur** for the writeup.
 
## Out of scope for v1
 
- Multiple model comparisons (Opus, GPT-5, etc.) — this is a follow-up post.
- Latency / wall-clock metrics — collected as observability, not headlined.
- Variance across pMCP prompt versions — pick one, log it, iterate later.
- Comparison to WarpGrep / other published scaffolding interventions — cite them in the post, don't try to re-run them.
- Any modifications to pMCP itself based on benchmark findings — that's a v2 conversation after the post ships.
 
## Notes for the coding agent
 
- Variance will be larger than you expect. Across 5 runs of the same (task, arm), expect ±1-2 resolved tasks. This is the noise floor; the effect we're hunting is hopefully larger.
- METR has shown that SWE-bench-passing PRs would not be merged ~half the time by maintainers. Pass rates on Pro are upper bounds on real-world usefulness. Note this once in the eventual writeup; do not adjust the metric.
- The coding agent should **not** tune anything for the benchmark. No prompt iteration on the test prompts mid-run, no model swaps, no "let me try with reasoning enabled." Pin every variable, log it, leave it alone. Tuning during a benchmark contaminates the result and the credibility of the post depends on this not happening.
- If the result is "pMCP doesn't help" or "pMCP makes things worse," **that is also a publishable result** and arguably more interesting. Do not optimize for a positive outcome. Optimize for a clean measurement.