# pMCP (Parent-MCP) — Channel Architecture

## Changes from Previous Design

The previous design doc described an SDK-based approach using `askSideQuestion` (private API), in-process MCP servers, and in-process hook callbacks. That approach was validated but can only be used programmatically via the Claude Agent SDK — it cannot be installed into a regular Claude Code session.

This document describes the **channel-based approach**: a standard MCP server with `claude/channel` capability, installable as a plugin, testable in any Claude Code session with `--dangerously-load-development-channels`. No SDK, no private APIs, no API keys.

### What changes

| | SDK approach | Channel approach |
|---|---|---|
| Transport for ask/notify | `askSideQuestion` (sidechain, ephemeral) | `notifications/claude/channel` (main conversation) |
| Ask response mechanism | Automatic (sidechain model call) | Parent must call `respond` tool with matching `request_id` |
| Inject hook | In-process callback | HTTP hook querying local HTTP endpoint |
| State | In-memory (SDK process) | In-memory (MCP server process) |
| Deployment | SDK scripts only | Plugin, `--channels` flag |
| API dependency | Private (`askSideQuestion`) | None (public MCP protocol) |

### What stays the same

- Three primitives: `ask`, `notify`, `inject`
- Freeform string payloads, no typed variants
- Background subagents required for full functionality
- `PreToolUse` hook + `additionalContext` for inject delivery
- Sibling isolation (parent is sole coordinator)
- No context layer (ask IS the context mechanism for MVP)

## Architecture

```
pMCP Channel Server (separate process)
├── MCP Server (stdio transport to Claude Code)
│   ├── claude/channel capability (notifications → parent session)
│   ├── instructions (tells parent how to handle ask/notify/respond)
│   └── Tools (inherited by subagents):
│       ├── ask(question)               — subagent → parent, blocking
│       ├── notify(message)             — subagent → parent, non-blocking
│       ├── respond(request_id, answer) — parent → subagent, unblocks ask
│       └── inject(agent_id, message)   — parent → subagent, via hook
├── HTTP Server (localhost:PORT)
│   └── POST /check-inject             — PreToolUse hook queries this
└── In-memory state
    ├── pendingAsks: Map<request_id, { resolve, question, timestamp }>
    └── injectInboxes: Map<agent_id, string[]>
```

### How tools reach subagents

The pMCP server is configured at session level (`.mcp.json`). Subagents inherit all session-level MCP tools by default, including `mcp__pmcp__ask` and `mcp__pmcp__notify`. No per-agent `mcpServers` configuration needed.

Channel notifications (`notifications/claude/channel`) are pushed from the MCP server to the CLI via stdio. They arrive in the parent's conversation as `<channel source="pmcp" type="..." ...>content</channel>` tags. This works even when the notification originates from a subagent's tool call — the CLI routes channel events to the parent session.

### Context consumption

**Every `ask` and `notify` permanently consumes parent context.** Unlike the SDK approach where sidechain messages were ephemeral, channel events are `<channel>` tags in the parent's main conversation. They persist through the session and count against the context window.

A subagent that sends 20 notifications costs 20 channel tags of parent tokens permanently. Three subagents each sending 5 asks and 10 notifications = 45 channel tags. This is the trade-off for deployability — channels are installable but not ephemeral.

Implications:
- Chatty subagents are expensive. The subagent prompt guidance (see below) must discourage notification spam.
- Context compaction will eventually reclaim old channel tags, but this creates its own problem (see "Context compaction and pending asks" below).
- Monitor context window consumption during real workloads to determine if batching or summarization is needed.

### Context compaction and pending asks

If the parent's context compacts during a long session, `<channel type="ask" request_id="req_5">` tags may be compacted away. The parent loses the request_id and can't call `respond`. But the pending ask is still in the server's memory and the subagent is still blocked.

Mitigations:
- **FIFO auto-matching** (see ask details below): if only one ask is pending, `request_id` is optional. The parent doesn't need to remember it.
- **Ask timeout** (120 seconds): if the parent never responds, the subagent gets a structured error and can proceed on assumption or abort.
- **Multiple pending after compaction**: the subagent times out, gets an error. Not ideal but the timeout is the safety net.

This is a known limitation for MVP. A future fix (server re-pushing pending asks on a trigger) is non-trivial and out of scope.

## Primitive Details

### ask(question) → response

**Flow:**
1. Subagent calls `mcp__pmcp__ask` with a question string
2. Server generates a `request_id`, **registers the pending promise in `pendingAsks` FIRST**
3. Server pushes `notifications/claude/channel` with `meta: { type: "ask", request_id }` and `content: question`
4. Parent sees `<channel source="pmcp" type="ask" request_id="req_1">question text</channel>`
5. MCP tool handler **blocks** — awaits the pending promise (timeout: 120 seconds)
6. Parent calls `mcp__pmcp__respond` with the matching `request_id` and an answer
7. Server resolves the promise, `ask` tool returns the answer to the subagent

**Critical implementation detail:** The pending promise MUST be registered in `pendingAsks` BEFORE the channel notification is pushed. Otherwise the parent can call `respond` before the promise is stored, causing a "no pending ask" error. This was a bug in the prototype — the notification fired first, creating a race condition.

**FIFO auto-matching for respond:** When the parent calls `respond`:
- If `request_id` is provided and matches a pending ask, deliver the answer.
- If `request_id` is omitted and exactly one ask is pending, auto-match and deliver.
- If `request_id` is omitted and multiple asks are pending, return an error listing all pending asks with their questions, e.g.: `"Multiple pending asks. Specify request_id: req_3 ('What database?'), req_4 ('What framework?')"`
- If `request_id` is provided but doesn't match, return an error listing current pending asks.

This eliminates the concurrent ask mismatch problem structurally. The common case (one pending ask) requires no request_id tracking. The multi-pending case fails loudly with actionable information instead of silently delivering the wrong answer.

**Timeout:** Ask blocks for a maximum of 120 seconds. On timeout:
- The pending ask is removed from `pendingAsks`
- The tool returns a structured error: `"ASK_TIMEOUT: Parent did not respond within 120 seconds. Question was: '[question]'. Proceed on your best judgment or abort."`
- The subagent decides whether to continue on assumption or stop

**Validated:** Sequential asks from same subagent (France→Paris, Japan→Tokyo) — both answers received correctly. Single ask round-trip confirmed (subagent echoed "Parent told me the answer is: The answer is 4, and pMCP works.").

### notify(message)

**Flow:**
1. Subagent calls `mcp__pmcp__notify` with a message string
2. Server pushes `notifications/claude/channel` with `meta: { type: "notify" }` and `content: message`
3. Tool returns immediately to subagent
4. Parent sees `<channel source="pmcp" type="notify">message</channel>` in its conversation

**Context cost:** Each notification is a permanent `<channel>` tag in the parent's context. Subagents should batch routine progress and only notify on significant milestones.

**Validated:** All notifications arrived in order, real-time. Parent tracked progress and reacted to notifications while subagents were still running. Multiple concurrent subagents sending interleaved notifications — all delivered correctly.

### inject(agent_id, message)

**Flow:**
1. Parent calls `mcp__pmcp__inject` with an `agent_id` and message
2. Server stores the message in the in-memory inbox for that agent
3. On the subagent's next tool call, the `PreToolUse` hook fires
4. Hook (HTTP type) POSTs the hook input JSON directly to the server's `/check-inject` endpoint
5. Server reads `agent_id` from the hook input, checks the inbox, returns `additionalContext` if messages exist
6. The CLI injects the context into the subagent's conversation

**Hook configuration** (`.claude/settings.json`):
```json
{
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

No shell script. The hook input JSON is POSTed directly to the server URL. The server reads `agent_id` from the input and returns the hook response. This eliminates bash/jq/curl process overhead.

**Overhead:** Every tool call in every subagent triggers an HTTP POST to the local server, even when there are no pending messages. This is a lightweight HTTP round-trip (~1-5ms on localhost) compared to spawning a shell process. For most workloads this is negligible.

**Validated:** Inject delivered on subagent's next tool call. Subagent incorporated the correction — removed milk from shopping list after parent injected "Remove milk, we already have milk at home." Final list correctly reflected the change.

## Server Instructions

The `instructions` field in the MCP server constructor tells the parent how to handle pMCP events:

```
You have a parent-subagent communication system called pMCP.

When you see <channel source="pmcp"> events, they are messages from your subagents:

- **ASK events** (<channel source="pmcp" type="ask" request_id="...">):
  A subagent is blocked waiting for your answer. Call mcp__pmcp__respond to
  answer. If there's only one pending ask, request_id is optional. If there
  are multiple, the error will list them with their questions — use the
  matching request_id.

- **NOTIFY events** (<channel source="pmcp" type="notify">):
  Informational updates from subagents. No response needed. Use these to
  track progress and catch misalignment early.

To send a message to a running subagent, call mcp__pmcp__inject with the
agent's ID and your message. The message is delivered on the subagent's
next tool call.
```

## Subagent Prompt Guidance

pMCP-enabled subagents should include the following in their system prompt. This is a versioned artifact — iterate based on real usage.

**v1:**
```
You have access to pMCP communication tools for talking to your parent agent:

- mcp__pmcp__ask: Ask the parent a blocking question when you need
  clarification, face an ambiguous decision, or are unsure about scope.
  Use sparingly — each ask pauses your work and consumes parent context.
  
- mcp__pmcp__notify: Send a non-blocking progress update to the parent.
  Use for significant milestones, unexpected discoveries, or approach
  changes. Do NOT notify for every small step — batch routine progress.

Guidelines:
- Ask BEFORE making assumptions on ambiguous requirements
- Notify when you find something unexpected or change approach  
- If you receive a [MESSAGE FROM PARENT], acknowledge and adjust accordingly
- Prefer fewer, more meaningful notifications over frequent small updates
```

## Configuration Files

The server requires two files in the project:

**`.mcp.json`** — registers the MCP server:
```json
{
  "mcpServers": {
    "pmcp": {
      "command": "bun",
      "args": ["./server.ts"]
    }
  }
}
```

**`.claude/settings.json`** — permissions and inject hook:
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

## Starting Claude Code with pMCP

```bash
claude --dangerously-load-development-channels server:pmcp
```

Subagents should be spawned in the background so the parent is free to call `respond` and `inject`.

## Validation

Tested against Claude Code v2.1.105 with `--dangerously-load-development-channels`.

| Test | Result | Notes |
|---|---|---|
| `notify` — single | PASS | Arrived in parent conversation in real-time |
| `notify` — multiple ordered | PASS | All notifications arrived in order |
| `notify` — concurrent subagents | PASS | Interleaved correctly, no cross-contamination |
| `ask` + `respond` — single round-trip | PASS | Subagent received answer, echoed it back via notify |
| `ask` — sequential (same subagent, 2 asks) | PASS | France→Paris, Japan→Tokyo, both correct |
| `ask` — concurrent (2 subagents) | PARTIAL | Answers swapped — fixed by FIFO auto-matching (not yet retested) |
| `inject` — delivery via hook | PASS | Delivered on next tool call, subagent acknowledged |
| `inject` — behavioral influence | PASS | Subagent incorporated correction (removed milk from list) |

## Implementation Changes Required

These changes must be made to `server.ts` before handoff:

1. **Fix ask race condition.** Register the pending promise in `pendingAsks` BEFORE pushing the channel notification. Current code pushes notification first, creating a race where `respond` can arrive before the promise is stored.

2. **FIFO auto-matching in respond.** Make `request_id` optional. If omitted and one pending ask, auto-match. If omitted and multiple pending, return error listing all pending asks with questions. If provided and wrong, return error listing current pending.

3. **Ask timeout (120 seconds).** Add `Promise.race` with a 120-second timeout. On expiry, clean up `pendingAsks` and return structured error to the subagent.

4. **Switch hook to HTTP type.** Delete `.claude/hooks/check-inject.sh`. Update `.claude/settings.json` to use `type: "http"` with `url: "http://127.0.0.1:8799/check-inject"`. The `/check-inject` endpoint already accepts the full hook input JSON — no server changes needed.

5. **Make respond tool `request_id` optional.** Update the tool's `inputSchema` to remove `request_id` from the `required` array.

## Open Questions

1. **Context layer** — is `ask` sufficient as a context mechanism, or do subagents need a read-only context store? Ship communication first, measure where subagents ask repetitive questions, then decide.

2. **Sibling awareness** — should siblings see each other's traffic? Current design says no. The channel architecture has a natural extension path (a sibling-notify channel type) if overlap becomes a measurable problem. Don't build it, but know it's there.

3. **Context consumption monitoring** — track how many channel tags accumulate in real workloads. If context fills too fast, consider batching notifications or adding a notify rate limit.

4. **Instructions iteration** — the `instructions` field text is functional but will need iteration based on real usage patterns. Specifically: what makes a good `respond` answer, and how to handle the multi-pending case naturally.
