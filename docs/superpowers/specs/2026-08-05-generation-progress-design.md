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
| `system` / `init` | `resolvedModel`, session id |
| `assistant` | one turn; each `tool_use` content block → one activity entry |
| `user` | each `tool_result` content block → marks the matching entry `done` or `failed` |
| `result` | the agent's final text, `subtype` / `is_error`, and canonical `num_turns` |

Activity entries are matched to their results by `tool_use_id`, held in a `Map`
alongside the ring. A result whose entry has already been evicted from the
20-entry ring is ignored.

**Turns are counted per top-level `assistant` message, not per `tool_use`
block** — one message can carry several parallel tool calls, and counting blocks
would inflate the number. Messages carrying a non-null `parent_tool_use_id` come
from a subagent and are excluded from both the turn count and the activity ring;
the `stage-chapters` skill does not spawn subagents today, but the filter keeps
the number correct if it ever does. The `result` event's `num_turns` is the
canonical final count and overwrites the running tally.

Events are validated with permissive Zod schemas at this boundary — an external
process is a system boundary, so validation belongs here. Unknown event types
and unknown content blocks are ignored, which is deliberate forward
compatibility: the wire format gains variants regularly, and a new event type
must not fail a run.

### Behavior change: where the runId comes from

Today the runId is the last line of stdout. Under `stream-json`, stdout is JSON,
so the runId moves into the `result` event's `result` field (the agent's final
assistant text). `parseRunnerOutput` keeps its current signature and contract but
is fed that text instead of raw stdout.

This is the single place the change can silently break generation, so it is
covered by a test against a recorded stream-json fixture.

**The `result` field exists only on the success variant.** Error variants
(`error_max_turns`, `error_during_execution`) carry no final text, so "reject
with the result's message" is not a definition. The schema models `result`,
`error`, and `errors` as optional, and `errorResultMessage(event)` takes the
first non-empty of:

1. `errors` joined with `; `, sanitized
2. `error`, sanitized
3. a phrase for a known subtype — `error_max_turns` → "The agent hit its turn
   limit."; `error_during_execution` → "The agent errored during execution."
4. `` `Agent failed: ${subtype}` `` for a subtype we don't recognize

The sanitized stderr tail and, when non-zero, the `droppedLines` count are
appended to whatever that yields.

### Process settlement

`execFile` handled process lifecycle for us; `spawn` does not, and getting this
wrong is the most dangerous part of the change. A missing `error` listener throws
an unhandled event and takes the daemon down with it, and resolving the moment a
`result` event arrives would accept a process that then dies non-zero.

**`run()` settles only on `close`.** This is a queue-safety requirement, not just
tidiness: `JobManager.drain()` awaits the runner promise, so settling while the
child is still alive would start the next agent against a worktree the previous
one may still be writing. A timed-out job must keep the promise pending through
SIGTERM and, if needed, SIGKILL, until the process is actually gone.

Inputs are recorded; `close` decides.

| Input | Effect |
| --- | --- |
| `child.on("error")` (spawn failed, or signal delivery failed) | record the error; do **not** settle — Node emits `close` after a failed spawn |
| valid `result` event | record it; do **not** settle |
| duplicate `result` event | ignore the second |
| timeout fires | record `terminationCause = "timeout"`, send `SIGTERM`, arm the escalation timer; do **not** settle |
| escalation timer fires | send `SIGKILL`; do **not** settle |
| `close` | settle, exactly once, by the precedence below |

Precedence at `close`, first match wins:

1. `terminationCause === "timeout"` → reject as a timeout, **overriding** the
   observed signal or exit code. The signal is only how we killed it.
2. a recorded spawn `error` → reject with it
3. non-zero exit code → reject with the code, even if a success result was
   recorded
4. terminated by a signal we did not send → reject naming the signal
5. no recorded result → reject: "agent exited without a result event"
6. recorded error result → reject via `errorResultMessage`
7. recorded success result → resolve with the parsed runId

Every terminal path clears both the timeout and escalation timers.

The one exception to settle-on-close: if `error` fires and no `close` follows
within a short grace period, `run()` rejects anyway. A process that never closes
would otherwise wedge the queue permanently, which is the exact hazard the
settle-on-close rule exists to prevent.

Timeout is handled here rather than through `spawn`'s `timeout` option because
Node documents that a kill signal does not guarantee termination, and because the
option would settle the process without giving us the escalation step.

### Malformed input

Progress fidelity and outcome fidelity get different treatment, because they
carry different risk.

- **Progress is best-effort.** A malformed JSON line, or a known event whose
  payload fails its schema, is skipped and counted in a `droppedLines` tally.
  Aborting a four-minute agent run over one corrupt line buys nothing.
- **Outcome is guaranteed.** The settlement machine above never infers success
  from silence. If the dropped line *was* the terminal result, `close` finds no
  recorded result and rejects loudly.

Any rejection message includes the `droppedLines` count when it is non-zero, so
a corrupt stream is visible in the failure rather than hidden behind it.

### Other consequences of `spawn`

- `maxBuffer` disappears — the stream is consumed incrementally, so the 10 MB
  output ceiling is gone.
- Stderr is accumulated as a bounded, sanitized tail (see Telemetry safety) for
  use in rejection messages, replacing the current `stderrTail` read of a fully
  buffered string.

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

Detection keys on CLI subcommand names — the CLI's own stable contract, rather
than skill prose that changes freely. Two rules make the detection precise
rather than approximate:

**Anchored parsing, not substring search — and anchored to the forms the skill
actually emits.** A leading-token parser is wrong here: `SKILL.md:38` invokes
prep as command substitution inside an assignment,

```bash
PREP_FILE=$(stagereview prep)
```

so `stagereview` is never the first token. Step 5 is worse — one multiline Bash
call that opens with `AGENT_OUTPUT=$(mktemp …)` and continues into a `cat`
heredoc (`SKILL.md:298`). Only `stagereview import` arrives in leading position.

The recognizer therefore scans each line of the command for `stagereview`
preceded by nothing but a command-position prefix: start of line, `$(`, a
backtick, `&&`, `||`, `;`, or `|`, with an optional `VAR=` immediately before a
`$(`. That is a narrow recognizer for known forms, not a shell parser — writing
a general one by hand is out of scope, and pulling in a shell-parsing library for
two commands is not worth the dependency.

Write-phase detection keys on the literal heredoc delimiter `AGENT_EOF` appearing
in the command, or a `Write` tool targeting a `stage-agent-output*` path. The
delimiter is a distinctive fixed token the skill specifies verbatim, which makes
it a more reliable signal than trying to parse the redirect.

**Tests use commands copied verbatim from `SKILL.md`**, not simplified
`stagereview prep` fixtures — a fixture that omits the `$(…)` wrapper would pass
against a parser that fails in production.

**Phases advance on successful completion, not on invocation.** Seeing the
`stagereview prep` `tool_use` does not leave Prep. The tracker records that
`tool_use_id` and advances to Analyze only when the matching `tool_result`
arrives with `is_error` unset. A prep that fails keeps the rail on Prep, which is
the truth — the alternative shows a user "Analyze" for a run that never got a
diff.

| Entry signal | Phase |
| --- | --- |
| session start | Prep |
| successful `tool_result` for the `stagereview prep` call | Analyze |
| Bash writing the agent-output temp file, or a `Write` to a `stage-agent-output*` path | Write |
| `stagereview import` invoked | Import |

`PhaseTracker` is a pure class holding this mapping. It is **monotonic**: the
phase is the running maximum over the phase ordinal, so an agent that re-reads a
file after writing chapters cannot rewind the rail.

## Modules

New, all under `packages/cli/src/generation/`:

- **`agent-session.ts`** — one class per agent process. Owns `spawn`, the
  settlement state machine, and stderr handling. Process I/O only.
- **`stream-reducer.ts`** — pure. Owns the whole line-to-progress path:

  ```ts
  consumeLine(line: string): void
  snapshot(): JobProgress
  ```

  `consumeLine` does the JSON parsing, the Zod validation, and the
  `droppedLines` accounting, then folds the event into the activity ring, the
  `tool_use_id` correlation map, the turn count, and the phase. `AgentSession`
  hands it raw lines and never parses one itself — otherwise the reducer could
  not count parse failures it never saw, and "process I/O only" would be a
  fiction.

  `snapshot()` returns a deep copy: the activity ring is mutable and reducer-
  owned, and handing `JobManager` a live reference would let it observe entries
  changing underneath a response it has already begun serializing.
- **`phase-tracker.ts`** — the pure phase mapping described above.
- **`describe-tool-use.ts`** — `(name, input) → { tool, target }`.

Splitting the reducer out of `AgentSession` is what makes the event-folding
tests genuinely pure units rather than process tests wearing a unit's clothes.

`JobManager` remains a queue and gains no stream knowledge. `JobRunner` grows a
second parameter, `onProgress`, and `JobManager` stores the latest snapshot on
the job.

`AgentSession` calls `onProgress` with a snapshot **immediately after a
successful spawn**, before any event arrives. Without that first push, `progress`
would stay `null` until `system/init` lands seconds later, and a running job
would be indistinguishable from a queued one for that window — the exact gap the
three-state table below exists to close.

### Telemetry safety

Activity targets and stderr both carry text the agent produced while reading the
user's code, so both are constrained before they reach a UI or a terminal.

`describeToolUse` rules:

| Tool | Target |
| --- | --- |
| `Read` / `Write` / `Edit` | `file_path` relative to `repoRoot`; a path resolving outside `repoRoot` renders as its basename only |
| `Bash` | see the program allowlist below |
| `Glob` / `Grep` | the `pattern`, capped at 60 characters |
| anything else | empty — the tool name alone |

**Bash program allowlist.** The command's first token is matched against a known
set — `stagereview`, `git`, `gh`, `mktemp`, `cat`, `which`, `rg`. An allowlisted
program renders its first command line capped at 80 characters; anything else
renders as the literal string `Shell command` with no detail. The agent's
vocabulary in this workflow is small and known, so the allowlist keeps the useful
cases (`gh pr diff 42`, `stagereview prep --pr 42`) while bounding an unexpected
command to a label.

First-line-only matters for `cat`: the heredoc that writes chapter JSON would
otherwise dump agent-authored prose about the user's code into the UI. The entry
reads `cat > "$AGENT_OUTPUT" << 'AGENT_EOF'` and nothing more.

**Sanitization** applies to every target and every stderr line before display:
ANSI escapes and C0/C1 control characters are stripped, so nothing rendered into
a terminal or the DOM can carry cursor manipulation or color injection.

This satisfies `CLAUDE.md`'s logging rule, whose bar is "nothing that could
include user code beyond what the user explicitly asked the CLI to display" —
the displayed set is now a bounded, sanitized, allowlisted vocabulary rather
than arbitrary agent output.

## Wire format

### Prerequisite: move `GENERATION_MODEL` into the types package

`GENERATION_MODEL` and `GenerationModel` currently live in
`packages/cli/src/generation/job-manager.ts:6`, on the CLI side of the package
boundary. `GenerationJobSchema` now needs the type, and a shared wire schema
cannot import from the CLI. Both move to `@stagereview/types/generation`; the
CLI and web import them from there. `generate.ts`'s `z.enum(GENERATION_MODEL)`
is unaffected beyond its import path.

`JobRequest.model` is renamed to `requestedModel` rather than mapped, because
`Job extends JobRequest, GenerationJob` — leaving both a `model` and a
`requestedModel` on the same object invites picking the wrong one. The rename
touches `enqueue`, `claudeRunner`'s `--model` argument, and the `POST` handler;
the request body's field stays `model`, since that is the public API.

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
  startedAt: number,            // epoch ms, set when the child spawns
  resolvedModel: string | null, // from system/init; null until it arrives
  turns: number,
  phase: GenerationPhase,
  activity: ActivityEntry[],    // last 20, newest last
}
```

`GenerationJobSchema` gains:

- `prUrl: string` — lets the dashboard match jobs to rows; already
  client-derivable and carries nothing sensitive.
- `requestedModel: GenerationModel` — known at enqueue time, so it is always
  present, including while queued.
- `progress: JobProgress | null` — null until the child spawns.

**Three states, not two.** The model the user asked for is known at enqueue; the
model the CLI actually resolved is not known until `system/init`, which is
several seconds into a running job. Splitting `requestedModel` from a nullable
`resolvedModel` means no field is ever a lie, and the UI always has a model to
show.

| Job state | `progress` | `resolvedModel` | Rendered as |
| --- | --- | --- | --- |
| queued | `null` | — | existing "Queued — N ahead" line, unchanged |
| running, pre-init | non-null | `null` | rail on Prep, `requestedModel`, elapsed, no activity yet |
| running, post-init | non-null | set | full card |

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

**Terminal transitions must invalidate the PR list.** `GET /api/generate`
returns only non-terminal jobs, so a finished job simply vanishes from the set.
`usePullRequests` has `staleTime: 60_000` and **no** `refetchInterval`
(`packages/web/src/lib/use-pull-requests.ts:8`), so becoming stale does not make
it refetch — nothing would trigger one. Without a fix, a dashboard tab watching a
job would drop the "Import" badge and never gain "Chaptered" until something else
happened to invalidate the query.

`useActiveJobs` therefore diffs successive responses: any `jobId` present in the
previous set and absent from the current one invalidates
`PULL_REQUESTS_QUERY_ROOT` and `RUNS_QUERY_KEY`. This mirrors what
`usePrResolution` already does on its own job's terminal transition, but covers
the dashboard, which has no per-job poll of its own.

### Presentation criteria

Acceptance criteria for the rail and activity list, so they don't get decided
ad hoc during implementation:

- The current phase is identified semantically — a text label plus
  `aria-current="step"` — not by color alone.
- Activity state glyphs carry accessible labels (`running` / `done` / `failed`);
  they are never the sole carrier of meaning.
- The elapsed-time counter is **not** in a live region. A polite announcement
  every second would make the page unusable with a screen reader.
- Long targets truncate with `text-overflow` inside a fixed-width container; the
  card's width never depends on the longest path the agent happened to touch.
- The newest activity entry stays visible without manual scrolling.
- The four-phase rail degrades to a stacked or abbreviated form on narrow
  layouts rather than overflowing.

**`ResolverView`** — the `progress` and `failed` variants each carry the
progress snapshot:

```ts
| { tag: "failed"; error: string; progress: JobProgress | null }
| { tag: "progress"; queuePosition: number | null; progress: JobProgress | null }
```

## Backend logging

`AgentSession` logs one line per phase transition, prefixed with a short job tag
— a significant operation boundary, which is what the logging rule permits.

It also tees the child's stderr to `process.stderr`, line-prefixed with the same
tag. Every line goes through the sanitizer from Telemetry safety first (control
characters and ANSI escapes stripped), is capped in length, and the tee is capped
in total lines per job so a chatty failure cannot flood the terminal. The same
bounded, sanitized tail feeds rejection messages.

Stdout is **not** teed. It is the JSON event stream and would put file contents
and agent output into the terminal.

## Error handling

The settlement table under Process settlement is authoritative for how a run
ends. This covers everything else:

| Situation | Behavior |
| --- | --- |
| Malformed JSON line, or known event failing its schema | skipped; `droppedLines` incremented; parsing continues |
| Unknown event type or content block | ignored (forward compatibility) |
| `tool_result` for an entry already evicted from the ring | ignored |
| Assistant message with non-null `parent_tool_use_id` | excluded from turns and activity |
| `result` text whose last line is not a UUID | reject via existing `parseRunnerOutput` |
| Poll for an unknown job id | 404, unchanged |

A job that fails keeps its last progress snapshot, including the phase it died
in and the failed activity entry, so `FailedCard` can show them.

## Testing

Following TESTING.md's priority order.

**Route / server integration** — both GET endpoints against a real server with a
fake runner that emits scripted progress: a job mid-run reports its phase and
activity; a failed job retains its snapshot; `GET /api/generate` lists only
non-terminal jobs; a queued job reports `requestedModel` with `progress: null`.

**Process lifecycle** — `AgentSession` against a stub child process. These cover
the races that `execFile` used to handle for us and are the highest-risk part of
the change:

- spawn `error` (missing binary) rejects rather than throwing an unhandled
  event — the stub emits `error` **followed by** `close`, matching Node's
  documented behavior, and the run must settle once
- `error` with no `close` following rejects via the grace-period backstop
- exit by a signal we did not send rejects naming the signal
- zero exit with no result event rejects
- valid success result followed by a non-zero close rejects
- duplicate `result` events settle once
- timeout sends `SIGTERM`, then escalates to `SIGKILL` when no close follows
- **the runner stays pending between `SIGTERM` and `close`, and the next queued
  job does not start during that window** — asserted through `JobManager`, since
  this is the property that keeps two agents off one worktree
- a timed-out child that closes via `SIGTERM` rejects as a *timeout*, not as a
  signal termination
- an error `result` with no `result` field produces a message from `errors` /
  `error` / the subtype phrase, in that order

**Pure logic units**

- `PhaseTracker` — recognizes `PREP_FILE=$(stagereview prep)` and the multiline
  `AGENT_OUTPUT=$(mktemp …)` + `cat … << 'AGENT_EOF'` block **verbatim from
  `SKILL.md`**; advances only on a *successful* prep `tool_result` matched by
  `tool_use_id`; a failed prep stays in Prep; does not fire on a command that
  merely mentions `stagereview import` in an `echo` or a heredoc body; never
  rewinds; unknown tools leave the phase alone.
- `StreamReducer` — `consumeLine` on malformed JSON increments `droppedLines`
  without aborting; one assistant message with parallel tool calls counts as one
  turn; subagent messages are excluded; `num_turns` from the result overwrites
  the tally; the ring evicts in order; `snapshot()` returns a copy that later
  mutations do not touch.
- `describeToolUse` — path relativization, a path outside `repoRoot`, the Bash
  program allowlist (allowlisted and non-allowlisted), the heredoc case
  specifically, control-character and ANSI stripping, unknown tools.

**Web** — one `resolver-view` case per new variant, and a `useActiveJobs` test
that a job leaving the active set invalidates the PR list query. No test for the
rail's markup (static rendering) and none for the `FailedCard` disclosure
itself — `TESTING.md:66` puts UI library component behavior out of scope, and
§4's exception is scoped to keyboard navigation, focus, and forms.

## Out of scope

- Persisting progress to SQLite. Progress lives in memory and dies with the
  daemon, exactly as jobs already do.
- Cost or token reporting.
- Cancelling a run from the UI.
- Streaming partial assistant text (`--include-partial-messages`).
