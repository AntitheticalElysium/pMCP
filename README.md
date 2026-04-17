# pMCP

Parent-subagent communication for Claude Code via MCP channels.

pMCP gives Claude Code subagents the ability to talk back to their parent agent through three primitives:

- **ask** — subagent asks the parent a blocking question, waits for a response
- **notify** — subagent sends a non-blocking update to the parent
- **inject** — parent proactively sends a message to a running subagent

Without pMCP, subagents work in isolation: the parent delegates, the subagent executes, and there's no communication until the subagent returns. pMCP adds a bidirectional channel so the parent can course-correct and the subagent can surface discoveries mid-task.

## Architecture

```
pMCP Server (separate process)
├── MCP Server (stdio transport to Claude Code)
│   ├── claude/channel capability
│   └── Tools: ask, notify, respond, inject
├── HTTP Server (localhost:8799)
│   └── POST /check-inject (PreToolUse hook endpoint)
└── In-memory state
    ├── pendingAsks: Map<request_id, { resolve, question }>
    └── injectInboxes: Map<agent_id, string[]>
```

## Quick Start

```bash
# Install dependencies
bun install

# Start Claude Code with pMCP
claude --dangerously-load-development-channels server:pmcp
```

Subagents inherit the pMCP tools automatically. The parent sees `<channel>` events in its conversation when subagents call `ask` or `notify`.

## How It Works

**ask** — The subagent calls `mcp__pmcp__ask`. The server registers a pending promise and pushes a channel notification to the parent. The subagent blocks until the parent calls `mcp__pmcp__respond` with an answer (timeout: 120s).

**notify** — The subagent calls `mcp__pmcp__notify`. The server pushes a channel notification to the parent. The subagent continues immediately.

**inject** — The parent calls `mcp__pmcp__inject` with an agent_id and message. The server stores the message in an inbox. On the subagent's next tool call, the `PreToolUse` HTTP hook delivers it as `additionalContext`.

## Configuration

### `.mcp.json`
```json
{
  "mcpServers": {
    "pmcp": {
      "command": "bun",
      "args": ["server.ts"]
    }
  }
}
```

### `.claude/settings.json`
```json
{
  "permissions": {
    "allow": [
      "mcp__pmcp__ask",
      "mcp__pmcp__notify",
      "mcp__pmcp__respond",
      "mcp__pmcp__inject"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:8799/check-inject",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

## Benchmark

The `benchmark/` directory contains a harness for evaluating pMCP on [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os) using the Claude Agent SDK. It compares three configurations:

| Arm | Description |
|-----|-------------|
| A | Single agent — no subagents, no delegation |
| B | Vanilla subagents — worker subagent without pMCP |
| C | pMCP subagents — worker subagent with ask/notify/inject |

```bash
cd benchmark
bun install
bun harness.ts --task-file task_selection.txt --runs 3 --arms A,B,C
```

Results are written to `benchmark/runs.jsonl`. See [BENCHMARK.md](BENCHMARK.md) for the full specification.

## Project Structure

```
server.ts              Channel-based pMCP server (for Claude Code sessions)
sdk/                   SDK-based pMCP (for programmatic use via Agent SDK)
benchmark/
  harness.ts           Main benchmark orchestrator
  arms.ts              Arm A/B/C configuration and pMCP SDK integration
  runner.ts            Single-run executor with transcript capture
  tokens.ts            Token accounting (cache-aware)
  tasks.ts             SWE-bench Pro dataset loader
  docker.ts            Docker workdir management
  patches.ts           Patch capture and grader input generation
DESIGN.md              Architecture and design decisions
BENCHMARK.md           Benchmark specification and methodology
```
