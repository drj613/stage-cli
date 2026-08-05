# Generation progress — design

## Problem

Chapter generation is a black box. `claudeRunner` spawns `claude -p` through
`execFile` with plain-text output, so nothing about the run is observable until
the process exits and prints a runId. The UI shows a spinner and the words
"Chaptering…" for what can be several minutes. When a run fails, the user gets
an error string with no indication of how far the agent got.

The terminal running `stagereview start` is equally silent — the daemon prints
nothing about a job in flight.

## Goal

Surface what the headless agent is doing, while it does it:

- a coarse phase rail showing which step of the `stage-chapters` skill is active
- the specific tool calls happening inside the current phase
- the model in use, elapsed time, and turn count
- the same trail retained on failure, so an error says where it died
- a phase badge on dashboard PR rows for jobs in flight
- the agent's stderr teed to the daemon's terminal

Non-goals: persisting progress to SQLite, post-mortem history across daemon
restarts, cost reporting, cancellation.

## Where progress comes from

`claudeRunner` swaps `execFile` for `spawn`, adding `--output-format stream-json
--verbose`. Stdout becomes newline-delimited JSON, consumed through
`node:readline`.

| Event | What we take |
| --- | --- |
| `system` / `init` | the model the CLI actually resolved, session id |
| `assistant` | each `tool_use` content block → one activity entry; increments the turn count |
| `user` | each `tool_result` content block → marks the matching entry `done` or `failed` |
| `result` | the agent's final text, plus `subtype` / `is_error` for terminal status |

Activity entries are matched to their results by `tool_use_id`, held in a `Map`
alongside the ring. A result whose entry has already been evicted from the
20-entry ring is ignored.

Events are validated with permissive Zod schemas at this boundary — an external
process is a system boundary, so validation belongs here. Unknown event types
and unknown content blocks are ignored rather than rejected.

### Behavior change: where the runId comes from

Today the runId is the last line of stdout. Under `stream-json`, stdout is JSON,
so the runId moves into the `result` event's `result` field (the agent's final
assistant text). `parseRunnerOutput` keeps its current signature and contract but
is fed that text instead of raw stdout. A `result` event with `is_error: true`
or a `subtype` other than `success` rejects with its message.

This is the single place the change can silently break generation, so it is
covered by a test against a recorded stream-json fixture.

### Other consequences of `spawn`

- `maxBuffer` disappears — the stream is consumed incrementally, so the 10 MB
  output ceiling is gone.
- `AGENT_TIMEOUT_MS` moves to `spawn`'s own `timeout` option with
  `killSignal: "SIGTERM"`.
- A malformed JSON line is skipped, not fatal. One unparseable line must not
  kill a four-minute run.
- Non-zero exit still rejects with the stderr tail, unchanged.

## Phases

Four phases, chosen because these are the boundaries actually observable in the
tool stream:

```
Prep ──────── Analyze ──────── Write ──────── Import
 │              │                │               │
 start    prep result      heredoc to      stagereview
          arrives          $AGENT_OUTPUT      import
```

The skill has six numbered steps, but "the agent finished reading the diff and
started thinking" produces no signal, and the write is instantaneous rather than
a span. Four phases with real entry signals beat six where two are guesses.

Detection keys on `stagereview prep`, `AGENT_EOF` / `stage-agent-output`, and
`stagereview import` — CLI subcommand names, which are the CLI's own stable
contract, rather than skill prose that changes freely.

`PhaseTracker` is a pure class holding this mapping. It is **monotonic**: the
phase is the running maximum over the phase ordinal, so an agent that re-reads a
file after writing chapters cannot rewind the rail.

## Modules

New, all under `packages/cli/src/generation/`:

- **`agent-session.ts`** — one class per agent process. Spawns `claude`, parses
  the event stream, owns a `PhaseTracker` and a 20-entry activity ring, exposes
  `run(): Promise<string>` and a progress snapshot. This is where all
  stream-json knowledge lives.
- **`phase-tracker.ts`** — the pure phase mapping described above.
- **`describe-tool-use.ts`** — `(name, input) → { tool, target }`.

`describeToolUse` rules:

| Tool | Target |
| --- | --- |
| `Read` / `Write` / `Edit` | `file_path` made relative to `repoRoot` |
| `Bash` | first line of `command`, capped at 80 characters |
| `Glob` / `Grep` | the `pattern` |
| anything else | empty — the tool name alone |

The Bash truncation is deliberate, not cosmetic. The heredoc that writes chapter
JSON would otherwise dump agent-authored prose about the user's code into the
UI. First line only means the entry reads
`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'` and nothing more, satisfying the logging
rule against surfacing file contents.

`JobManager` remains a queue and gains no stream knowledge. `JobRunner` grows a
second parameter, `onProgress`, and `JobManager` stores the latest snapshot on
the job.

## Wire format

In `packages/types/src/generation.ts`:

```ts
export const GENERATION_PHASE = {
  PREP: "prep",
  ANALYZE: "analyze",
  WRITE: "write",
  IMPORT: "import",
} as const;

export const ACTIVITY_STATE = {
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
} as const;

ActivityEntrySchema = { tool: string, target: string, state: ActivityState }

JobProgressSchema = {
  model: string,        // resolved model from the init event
  startedAt: number,    // epoch ms, set when the child spawns
  turns: number,
  phase: GenerationPhase,
  activity: ActivityEntry[],  // last 20, newest last
}
```

`GenerationJobSchema` gains `prUrl: string` and `progress: JobProgress | null`.
`prUrl` lets the dashboard match jobs to rows; it is already client-derivable
and carries nothing sensitive.

## Routes

- `GET /api/generate/:jobId` — unchanged shape plus `prUrl` and `progress`.
- `GET /api/generate` — **new**. Returns `{ jobs: GenerationJob[] }` for every
  non-terminal job. One request serves the whole dashboard regardless of row
  count. Backed by a new `JobManager.activeJobs()`.

`POST /api/generate` is unchanged.

## UI

**`ProgressCard`** — phase rail across the top, a header line reading
`sonnet · 1m 42s · 14 turns`, and the activity list below it. Entries show the
tool, its target, and a state glyph.

Elapsed time ticks client-side from `startedAt` via a `useElapsed` hook so it
stays smooth between polls. This is a legitimate `useEffect` — a subscription to
an external clock, not derived state.

The job poll interval drops from 3 s to 1 s while a job is running; terminal
jobs still stop polling entirely.

**`FailedCard`** — the error message, a "Failed during: Write chapters" line
derived from the retained phase, and a collapsible trail of the last steps.

**`PullRequestRow`** — takes an optional `job` object (a single prop, per the
component-design rule against sibling props that always travel together) and
renders a spinner plus the phase name when that PR is generating. A
`useActiveJobs()` hook polls `GET /api/generate` every 3 s while the dashboard
is mounted. Rows match jobs by comparing `prUrl` to the row's own URL
case-insensitively, the same rule `JobManager.activeJobFor` already uses.

**`ResolverView`** — the `progress` and `failed` variants each carry the
progress snapshot:

```ts
| { tag: "failed"; error: string; progress: JobProgress | null }
| { tag: "progress"; queuePosition: number | null; progress: JobProgress | null }
```

## Backend logging

`AgentSession` tees the child's stderr to `process.stderr`, line-prefixed with a
short job tag. It logs one line per phase transition — a significant operation
boundary, which is exactly what the logging rule permits.

Stdout is **not** teed. It is the JSON event stream and would leak file contents
and agent output into the terminal.

## Error handling

| Situation | Behavior |
| --- | --- |
| Malformed JSON line | skipped; parsing continues |
| Unknown event type or content block | ignored |
| `result` with `is_error` or non-`success` subtype | reject with its message |
| `result` text whose last line is not a UUID | reject via existing `parseRunnerOutput` |
| Non-zero exit | reject with stderr tail, unchanged |
| Timeout | `spawn`'s `timeout` option, `SIGTERM` |
| Poll for an unknown job id | 404, unchanged |

A job that fails keeps its last progress snapshot so `FailedCard` can show it.

## Testing

Following TESTING.md's priority order.

**Route / server integration** — both GET endpoints against a real server with a
fake runner that emits scripted progress: a job mid-run reports its phase and
activity; a failed job retains its snapshot; `GET /api/generate` lists only
non-terminal jobs.

**Pure logic units**

- `PhaseTracker` — advances on each signal, never rewinds, unknown tools leave
  the phase alone.
- `describeToolUse` — path relativization, Bash first-line truncation, the
  heredoc case specifically, unknown tools.
- Stream parsing — a recorded `stream-json` fixture drives one full run:
  init → tool calls → results → result event, asserting the extracted runId,
  turn count, and final phase. Plus the error-result and malformed-line cases.

**Web** — one `resolver-view` case per new variant. No test for the rail's
markup, per the rule against testing static rendering.

## Out of scope

- Persisting progress to SQLite. Progress lives in memory and dies with the
  daemon, exactly as jobs already do.
- Cost or token reporting.
- Cancelling a run from the UI.
- Streaming partial assistant text (`--include-partial-messages`).
