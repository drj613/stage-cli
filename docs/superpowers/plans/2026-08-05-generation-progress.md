# Generation Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface what the headless `claude -p` chapter-generation agent is doing — phase, tool calls, model, elapsed time, turns — live in the Stage dashboard and on the daemon's terminal.

**Architecture:** `claudeRunner` moves from `execFile` to `spawn` with `--output-format stream-json --verbose`. A new `AgentSession` owns the child process and a single-settlement state machine; a pure `StreamReducer` folds raw stdout lines into a `JobProgress` snapshot; `JobManager` stores the latest snapshot per job and serves it over the existing poll plus a new list endpoint. The SPA renders a four-phase rail with an activity feed.

**Tech Stack:** Node 20 ESM, Zod 4, `node:child_process` / `node:readline`, Drizzle (untouched), React 19 + TanStack Query/Router, Tailwind 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-generation-progress-design.md`

---

## File Structure

**Created — `packages/cli/src/generation/`**

| File | Responsibility |
| --- | --- |
| `bash-commands.ts` | Pure. Recognizes which programs a Bash command invokes, in command position, ignoring heredoc bodies. Shared by phase detection and display. |
| `describe-tool-use.ts` | Pure. Turns a `tool_use` block into a displayable `{ tool, target }`, applying the program allowlist, path relativization, and text sanitization. |
| `phase-tracker.ts` | Pure. Monotonic four-phase state from tool events. |
| `stream-events.ts` | Zod schemas for the `stream-json` wire format + `parseStreamEvent`, which classifies a line as known / unknown / invalid. |
| `stream-reducer.ts` | Pure. `consumeLine(line)` → parsing, validation, dropped-line accounting, activity ring, turn count, phase. `snapshot()` → deep-copied `JobProgress`. |
| `agent-session.ts` | The only file that touches a process. `spawn`, stderr tee, timers, settlement state machine. |

**Created — web**

| File | Responsibility |
| --- | --- |
| `packages/web/src/lib/generation-labels.ts` | Phase and activity-state display labels. |
| `packages/web/src/lib/use-elapsed.ts` | Ticking elapsed-milliseconds hook. |
| `packages/web/src/lib/use-active-jobs.ts` | Polls `GET /api/generate`; invalidates the PR list when a job goes terminal. |
| `packages/web/src/components/generation/phase-rail.tsx` | The four-step rail. |
| `packages/web/src/components/generation/activity-list.tsx` | The tool-call feed. |
| `packages/web/src/components/generation/progress-summary.tsx` | `model · elapsed · turns` header line. |

**Modified**

| File | Change |
| --- | --- |
| `packages/types/src/generation.ts` | Owns `GENERATION_MODEL`, phases, activity, `JobProgress`, widened `GenerationJobSchema`, `ActiveGenerationJobsSchema`. |
| `packages/cli/src/generation/job-manager.ts` | `requestedModel` rename, `onProgress`, `activeJobs()`, `claudeRunner` delegates to `AgentSession`, `parseRunnerOutput` message. |
| `packages/cli/src/routes/generate.ts` | Wire the new fields; add `GET /api/generate`. |
| `packages/cli/src/routes/core.ts`, `index.ts`, `show.ts`, `start.ts` | Import `GENERATION_MODEL` from the types package. |
| `packages/web/src/lib/format.ts` | Extract `formatDurationSeconds`. |
| `packages/web/src/lib/resolver-view.ts` | `progress` and `failed` carry the snapshot. |
| `packages/web/src/lib/use-pr-resolution.ts` | 1 s poll while running. |
| `packages/web/src/app/pr.$owner.$repo.$number.tsx` | Rebuilt `ProgressCard` and `FailedCard`. |
| `packages/web/src/components/dashboard/pull-request-list.tsx` | Row phase badge. |
| `packages/web/src/app/index.tsx` | Feed active jobs into the lists. |

---

## Task 1: Move `GENERATION_MODEL` into the types package and rename `JobRequest.model`

The shared `GenerationJobSchema` needs `GenerationModel`, and a wire schema cannot import from the CLI package.

The same task renames `JobRequest.model` to `requestedModel`. `Job extends JobRequest, GenerationJob`, and Task 5 gives `GenerationJob` a `requestedModel` field — leaving a `model` on the same object means two names for one value and an easy way to read the wrong one. Renaming here keeps it to a single mechanical commit. The HTTP request body keeps its `model` field; that is the public API and does not change.

**Files:**
- Modify: `packages/types/src/generation.ts`
- Modify: `packages/cli/src/generation/job-manager.ts:6-17,164-194`
- Modify: `packages/cli/src/routes/generate.ts:1-27,58`
- Modify: `packages/cli/src/routes/core.ts:3`
- Modify: `packages/cli/src/index.ts:8`
- Modify: `packages/cli/src/show.ts:4`
- Modify: `packages/cli/src/start.ts:3`
- Modify: `packages/cli/src/__tests__/generate-route-harness.ts:7`
- Modify: `packages/cli/src/__tests__/job-manager.test.ts` (11 `enqueue` calls)
- Modify: `packages/cli/src/__tests__/pull-requests.routes.test.ts:112,125`

- [ ] **Step 1: Add the constant to the types package**

Prepend to `packages/types/src/generation.ts`, above `JOB_STATUS`:

```ts
export const GENERATION_MODEL = {
	SONNET: "sonnet",
	OPUS: "opus",
	HAIKU: "haiku",
} as const;
export type GenerationModel = (typeof GENERATION_MODEL)[keyof typeof GENERATION_MODEL];
```

- [ ] **Step 2: Delete the CLI-side copy and rename the field**

In `packages/cli/src/generation/job-manager.ts`, delete lines 6-11 (the `GENERATION_MODEL` object and its type) and change the import on line 3 plus the `JobRequest` interface:

```ts
import {
	type GenerationJob,
	type GenerationModel,
	isTerminalJobStatus,
	JOB_STATUS,
} from "@stagereview/types/generation";

export interface JobRequest {
	prUrl: string;
	repoRoot: string;
	/** The model the caller asked for. Named to match the wire field on GenerationJob. */
	requestedModel: GenerationModel;
}
```

In the same file, `claudeRunner` passes the model to the CLI — change line 174's `job.model` to `job.requestedModel`.

- [ ] **Step 3: Rename the field at every call site**

Run: `grep -rn "model: \|\.model\b" packages/cli/src | grep -v requestedModel | grep -v defaultModel`

Update each `JobRequest` literal. In `packages/cli/src/routes/generate.ts:58`:

```ts
				const jobId = active
					? active.id
					: jobs.enqueue({ prUrl, repoRoot, requestedModel: body.model });
```

In `packages/cli/src/__tests__/job-manager.test.ts` (11 sites) and
`packages/cli/src/__tests__/pull-requests.routes.test.ts:112,125`, change every
`model: "sonnet"` inside an `enqueue({ … })` call to `requestedModel: "sonnet"`.

Leave alone: `defaultModel` in `generate.ts` / `core.ts`, the `model` field on the
request body schema, and the `--model` CLI option. Those are the public API and
do not change.

- [ ] **Step 4: Update every importer**

In `packages/cli/src/routes/generate.ts`, replace the `../generation/job-manager.js` import block (lines 4-8) with:

```ts
import { GENERATION_MODEL, type GenerationModel } from "@stagereview/types/generation";
import type { JobManager } from "../generation/job-manager.js";
```

Note this changes the first import line too — `GenerateAccepted` and `GenerationJob` already come from `@stagereview/types/generation`, so merge the names into that one import rather than importing the module twice.

In `packages/cli/src/routes/core.ts` line 3:

```ts
import type { GenerationModel } from "@stagereview/types/generation";
import { claudeRunner, JobManager } from "../generation/job-manager.js";
```

In `packages/cli/src/index.ts` line 8, `packages/cli/src/show.ts` line 4, and `packages/cli/src/start.ts` line 3, change the source module to `@stagereview/types/generation` (keep `import type` where it already says `import type`).

In `packages/cli/src/__tests__/generate-route-harness.ts` line 7:

```ts
import type { GenerationModel } from "@stagereview/types/generation";
import { JobManager, type JobRequest } from "../generation/job-manager.js";
```

- [ ] **Step 5: Verify nothing still imports the old location**

Run: `grep -rn "GENERATION_MODEL\|GenerationModel" packages/cli/src packages/web/src`
Expected: every hit's import source is `@stagereview/types/generation`; no hit imports these names from `job-manager.js`.

- [ ] **Step 6: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, no new failures. A missed rename shows up here as a type error on a `JobRequest` literal.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/generation.ts packages/cli/src
git commit -m "refactor: move GENERATION_MODEL to types and rename JobRequest.model"
```

---

## Task 2: `commandInvocations` — the shared Bash recognizer

Phase detection and the display allowlist both need to know which programs a command actually invokes. A first-token check is wrong: the skill writes `PREP_FILE=$(stagereview prep)`, whose first token is `PREP_FILE=$(stagereview`.

**Files:**
- Create: `packages/cli/src/generation/bash-commands.ts`
- Create: `packages/cli/src/__tests__/bash-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/bash-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { commandInvocations, commandPrograms } from "../generation/bash-commands.js";

describe("commandInvocations", () => {
	it("sees through assignment-wrapped command substitution", () => {
		// Verbatim from skills/stage-chapters/SKILL.md step 1.
		expect(commandInvocations("PREP_FILE=$(stagereview prep)")).toEqual([
			{ program: "stagereview", args: ["prep"] },
		]);
	});

	it("keeps flags as args", () => {
		expect(commandInvocations("PREP_FILE=$(stagereview prep --pr 123)")).toEqual([
			{ program: "stagereview", args: ["prep", "--pr", "123"] },
		]);
	});

	it("handles the multiline mktemp + heredoc block from step 5", () => {
		const command = [
			'AGENT_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/stage-agent-output.XXXXXX")',
			`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
			'{ "chapters": [] }',
			"AGENT_EOF",
		].join("\n");
		expect(commandPrograms(command)).toEqual(["mktemp", "cat"]);
	});

	it("ignores program names inside a heredoc body", () => {
		const command = ["cat << 'EOF'", "stagereview import should not count", "EOF"].join("\n");
		expect(commandPrograms(command)).toEqual(["cat"]);
	});

	it("finds every program in a pipeline or chain", () => {
		expect(commandPrograms("git diff main | rg foo && gh pr view 1")).toEqual([
			"git",
			"rg",
			"gh",
		]);
	});

	it("skips leading environment assignments", () => {
		expect(commandInvocations("FOO=bar git push")).toEqual([
			{ program: "git", args: ["push"] },
		]);
	});

	it("reduces an absolute program path to its basename", () => {
		expect(commandPrograms("/usr/local/bin/stagereview import x")).toEqual(["stagereview"]);
	});

	it("returns nothing for an empty command", () => {
		expect(commandPrograms("   ")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/bash-commands.test.ts`
Expected: FAIL — cannot resolve `../generation/bash-commands.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/generation/bash-commands.ts`:

```ts
import path from "node:path";

export interface CommandInvocation {
	readonly program: string;
	readonly args: readonly string[];
}

/** `<< 'DELIM'`, `<<-DELIM`, `<< "DELIM"` — captures the delimiter word. */
const HEREDOC_OPENER = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
/** Anything that ends one command and starts another. `$(` opens a subshell. */
const SEGMENT_SEPARATOR = /\$\(|[;\n|&`()]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Redirections belong to the command but are not its program or its arguments. */
const REDIRECTION = /^[0-9]*[<>]/;

/**
 * Drops heredoc bodies. Chapter JSON is written through a heredoc, and its
 * contents must never be mistaken for commands the agent ran.
 */
function stripHeredocBodies(command: string): string {
	const kept: string[] = [];
	let delimiter: string | null = null;
	for (const line of command.split("\n")) {
		if (delimiter !== null) {
			if (line.trim() === delimiter) delimiter = null;
			continue;
		}
		kept.push(line);
		const opener = HEREDOC_OPENER.exec(line);
		if (opener) delimiter = opener[2] ?? null;
	}
	return kept.join("\n");
}

/**
 * Every program the command invokes in command position, with its arguments.
 *
 * This is a narrow recognizer for the shapes the stage-chapters skill emits —
 * assignment-wrapped command substitution, pipelines, and `&&` chains — not a
 * shell parser. A real parser is out of scope, and a dependency for two
 * commands is not worth the weight.
 */
export function commandInvocations(command: string): CommandInvocation[] {
	const invocations: CommandInvocation[] = [];
	for (const segment of stripHeredocBodies(command).split(SEGMENT_SEPARATOR)) {
		const words = segment.split(/\s+/).filter((word) => word !== "");
		const start = words.findIndex(
			(word) => !ASSIGNMENT.test(word) && !REDIRECTION.test(word),
		);
		if (start === -1) continue;
		const program = words[start];
		if (program === undefined) continue;
		invocations.push({ program: path.basename(program), args: words.slice(start + 1) });
	}
	return invocations;
}

/** Just the program names — the allowlist check does not care about arguments. */
export function commandPrograms(command: string): string[] {
	return commandInvocations(command).map((invocation) => invocation.program);
}

/** Whether the command runs `<program> <subcommand>` in command position. */
export function invokesSubcommand(
	command: string,
	program: string,
	subcommand: string,
): boolean {
	return commandInvocations(command).some(
		(invocation) => invocation.program === program && invocation.args[0] === subcommand,
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/bash-commands.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/generation/bash-commands.ts packages/cli/src/__tests__/bash-commands.test.ts
git commit -m "feat: recognize programs invoked by a bash command"
```

---

## Task 3: `describeToolUse` and text sanitization

Turns a `tool_use` block into something safe to render. Sanitization is written with character codes rather than a regex because Biome's recommended `noControlCharactersInRegex` rule rejects control-character escapes in regex literals.

**Files:**
- Create: `packages/cli/src/generation/describe-tool-use.ts`
- Create: `packages/cli/src/__tests__/describe-tool-use.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/describe-tool-use.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeToolUse, sanitizeText } from "../generation/describe-tool-use.js";

const REPO_ROOT = "/home/dev/clones/widgets";

describe("sanitizeText", () => {
	it("strips ANSI colour sequences", () => {
		expect(sanitizeText("\u001B[31mred\u001B[0m text")).toBe("red text");
	});

	it("strips an OSC sequence terminated by BEL", () => {
		expect(sanitizeText("\u001B]0;title\u0007done")).toBe("done");
	});

	it("replaces bare control characters with spaces and collapses runs", () => {
		expect(sanitizeText("a b\tc")).toBe("a b c");
	});
});

describe("describeToolUse", () => {
	it("relativizes a path inside the repo", () => {
		expect(
			describeToolUse("Read", { file_path: `${REPO_ROOT}/src/server.ts` }, REPO_ROOT),
		).toEqual({ tool: "Read", target: "src/server.ts" });
	});

	it("reduces a path outside the repo to its basename", () => {
		expect(describeToolUse("Read", { file_path: "/tmp/stage-prep-abc123" }, REPO_ROOT)).toEqual(
			{ tool: "Read", target: "stage-prep-abc123" },
		);
	});

	it("shows an allowlisted command even when wrapped in command substitution", () => {
		expect(
			describeToolUse("Bash", { command: "PREP_FILE=$(stagereview prep --pr 42)" }, REPO_ROOT),
		).toEqual({ tool: "Bash", target: "PREP_FILE=$(stagereview prep --pr 42)" });
	});

	it("hides a command that invokes anything outside the allowlist", () => {
		expect(describeToolUse("Bash", { command: "curl https://example.com" }, REPO_ROOT)).toEqual({
			tool: "Bash",
			target: "Shell command",
		});
	});

	it("shows only the first line of the chapter-writing heredoc", () => {
		const command = [`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`, '{ "chapters": [] }', "AGENT_EOF"].join(
			"\n",
		);
		expect(describeToolUse("Bash", { command }, REPO_ROOT)).toEqual({
			tool: "Bash",
			target: `cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
		});
	});

	it("caps a long allowlisted command", () => {
		const command = `git log ${"a".repeat(200)}`;
		const { target } = describeToolUse("Bash", { command }, REPO_ROOT);
		expect(target.length).toBe(80);
		expect(target.endsWith("…")).toBe(true);
	});

	it("caps a search pattern", () => {
		const { target } = describeToolUse("Grep", { pattern: "x".repeat(200) }, REPO_ROOT);
		expect(target.length).toBe(60);
	});

	it("gives an unknown tool no target", () => {
		expect(describeToolUse("WebFetch", { url: "https://example.com" }, REPO_ROOT)).toEqual({
			tool: "WebFetch",
			target: "",
		});
	});

	it("gives a malformed input no target rather than throwing", () => {
		expect(describeToolUse("Read", { nope: 1 }, REPO_ROOT)).toEqual({ tool: "Read", target: "" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/describe-tool-use.test.ts`
Expected: FAIL — cannot resolve `../generation/describe-tool-use.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/generation/describe-tool-use.ts`:

```ts
import path from "node:path";
import { z } from "zod";
import { commandPrograms } from "./bash-commands.js";

/**
 * Programs whose command line is safe to show verbatim. Anything else renders
 * as a bare label: the agent's vocabulary in this workflow is small and known,
 * and an unexpected command is not worth surfacing in full.
 */
const ALLOWED_BASH_PROGRAMS: ReadonlySet<string> = new Set([
	"stagereview",
	"git",
	"gh",
	"mktemp",
	"cat",
	"which",
	"rg",
]);
const OPAQUE_COMMAND = "Shell command";
const BASH_LIMIT = 80;
const PATTERN_LIMIT = 60;
const ELLIPSIS = "…";

const ESCAPE = 0x1b;
const BELL = 0x07;

function isControl(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Index just past the escape sequence starting at `start`. */
function endOfEscapeSequence(text: string, start: number): number {
	const next = text.charCodeAt(start + 1);
	// CSI — ESC [ … final byte in @-~
	if (next === 0x5b) {
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			i += 1;
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return i;
	}
	// OSC — ESC ] … BEL or ESC \
	if (next === 0x5d) {
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			if (code === BELL) return i + 1;
			if (code === ESCAPE) return i + 2;
			i += 1;
		}
		return i;
	}
	return start + 2;
}

/**
 * Removes ANSI escape sequences and control characters, then collapses
 * whitespace. Anything rendered into a terminal or the DOM goes through here,
 * so agent output cannot move the cursor, recolour the log, or smuggle
 * invisible characters into the UI.
 */
export function sanitizeText(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text.charCodeAt(i) === ESCAPE) {
			i = endOfEscapeSequence(text, i);
			continue;
		}
		out += isControl(text.charCodeAt(i)) ? " " : text[i];
		i += 1;
	}
	return out.replace(/\s+/g, " ").trim();
}

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}${ELLIPSIS}`;
}

export interface ToolDescription {
	readonly tool: string;
	readonly target: string;
}

const FilePathInput = z.object({ file_path: z.string() });
const CommandInput = z.object({ command: z.string() });
const PatternInput = z.object({ pattern: z.string() });

/** Repo-relative when the file is inside the clone; basename otherwise. */
function describePath(filePath: string, repoRoot: string): string {
	const relative = path.relative(repoRoot, filePath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		return path.basename(filePath);
	}
	return relative;
}

/**
 * Only the first line survives, which matters most for the chapter-writing
 * heredoc: its body is agent-authored prose about the user's code.
 */
function describeCommand(command: string): string {
	const programs = commandPrograms(command);
	if (programs.length === 0) return OPAQUE_COMMAND;
	if (!programs.every((program) => ALLOWED_BASH_PROGRAMS.has(program))) return OPAQUE_COMMAND;
	const firstLine = sanitizeText(command.split("\n")[0] ?? "");
	return firstLine === "" ? OPAQUE_COMMAND : cap(firstLine, BASH_LIMIT);
}

/**
 * A displayable description of one tool call. `input` is unvalidated wire data,
 * so every shape is parsed rather than assumed; a shape we don't recognize
 * degrades to the tool name alone rather than throwing.
 */
export function describeToolUse(name: string, input: unknown, repoRoot: string): ToolDescription {
	switch (name) {
		case "Read":
		case "Write":
		case "Edit": {
			const parsed = FilePathInput.safeParse(input);
			return {
				tool: name,
				target: parsed.success ? sanitizeText(describePath(parsed.data.file_path, repoRoot)) : "",
			};
		}
		case "Bash": {
			const parsed = CommandInput.safeParse(input);
			return { tool: name, target: parsed.success ? describeCommand(parsed.data.command) : "" };
		}
		case "Glob":
		case "Grep": {
			const parsed = PatternInput.safeParse(input);
			return {
				tool: name,
				target: parsed.success ? cap(sanitizeText(parsed.data.pattern), PATTERN_LIMIT) : "",
			};
		}
		default:
			return { tool: name, target: "" };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/describe-tool-use.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/generation/describe-tool-use.ts packages/cli/src/__tests__/describe-tool-use.test.ts
git commit -m "feat: describe agent tool calls safely for display"
```

---

## Task 4: Phase types and the phase tracker

**Files:**
- Modify: `packages/types/src/generation.ts`
- Create: `packages/cli/src/generation/phase-tracker.ts`
- Create: `packages/cli/src/__tests__/phase-tracker.test.ts`

- [ ] **Step 1: Add the phase enum to the types package**

Append to `packages/types/src/generation.ts`:

```ts
/**
 * The four boundaries actually observable in the agent's tool stream. The
 * stage-chapters skill has six numbered steps, but "finished reading, started
 * thinking" emits no signal — four honest phases beat six with two guesses.
 */
export const GENERATION_PHASE = {
	PREP: "prep",
	ANALYZE: "analyze",
	WRITE: "write",
	IMPORT: "import",
} as const;
export type GenerationPhase = (typeof GENERATION_PHASE)[keyof typeof GENERATION_PHASE];

/** Display order, and the ordinal the tracker's monotonic rule compares. */
export const GENERATION_PHASE_ORDER = [
	GENERATION_PHASE.PREP,
	GENERATION_PHASE.ANALYZE,
	GENERATION_PHASE.WRITE,
	GENERATION_PHASE.IMPORT,
] as const;
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/__tests__/phase-tracker.test.ts`:

```ts
import { GENERATION_PHASE } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { PhaseTracker } from "../generation/phase-tracker.js";

const PREP_COMMAND = "PREP_FILE=$(stagereview prep)";
const WRITE_COMMAND = [
	'AGENT_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/stage-agent-output.XXXXXX")',
	`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
	'{ "chapters": [] }',
	"AGENT_EOF",
].join("\n");
const IMPORT_COMMAND = 'stagereview import "$AGENT_OUTPUT" --pr 42';

describe("PhaseTracker", () => {
	it("starts in prep", () => {
		expect(new PhaseTracker().phase).toBe(GENERATION_PHASE.PREP);
	});

	it("stays in prep while prep is still running", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to analyze when prep succeeds", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t1", false);
		expect(tracker.phase).toBe(GENERATION_PHASE.ANALYZE);
	});

	it("stays in prep when prep fails", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t1", true);
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("ignores a result for a different tool call", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t2", false);
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to write on the heredoc opener", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: WRITE_COMMAND });
		expect(tracker.phase).toBe(GENERATION_PHASE.WRITE);
	});

	it("advances to write on a Write to the agent-output path", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Write", { file_path: "/tmp/stage-agent-output.AbC123" });
		expect(tracker.phase).toBe(GENERATION_PHASE.WRITE);
	});

	it("does not advance to write when a search merely mentions the delimiter", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: "rg AGENT_EOF src" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("advances to import", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: IMPORT_COMMAND });
		expect(tracker.phase).toBe(GENERATION_PHASE.IMPORT);
	});

	it("does not advance on a command that only mentions the import subcommand", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: "echo run stagereview import next" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});

	it("never rewinds", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Bash", { command: IMPORT_COMMAND });
		tracker.observeToolUse("t2", "Bash", { command: PREP_COMMAND });
		tracker.observeToolResult("t2", false);
		tracker.observeToolUse("t3", "Read", { file_path: "/repo/src/a.ts" });
		expect(tracker.phase).toBe(GENERATION_PHASE.IMPORT);
	});

	it("leaves the phase alone for unrelated tools", () => {
		const tracker = new PhaseTracker();
		tracker.observeToolUse("t1", "Read", { file_path: "/repo/src/a.ts" });
		expect(tracker.phase).toBe(GENERATION_PHASE.PREP);
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/phase-tracker.test.ts`
Expected: FAIL — cannot resolve `../generation/phase-tracker.js`.

- [ ] **Step 4: Implement**

Create `packages/cli/src/generation/phase-tracker.ts`:

```ts
import {
	GENERATION_PHASE,
	GENERATION_PHASE_ORDER,
	type GenerationPhase,
} from "@stagereview/types/generation";
import { z } from "zod";
import { invokesSubcommand } from "./bash-commands.js";

const STAGEREVIEW = "stagereview";
/**
 * The heredoc *opener*, not a bare mention of the delimiter — `rg AGENT_EOF`
 * must not advance the rail to Write.
 */
const AGENT_OUTPUT_HEREDOC = /<<-?\s*(['"])AGENT_EOF\1/;
const AGENT_OUTPUT_PATH = /stage-agent-output/;

const CommandInput = z.object({ command: z.string() });
const FilePathInput = z.object({ file_path: z.string() });

/**
 * Monotonic phase state derived from the agent's tool stream.
 *
 * Two rules keep it truthful. Phases advance on *successful completion*, not on
 * invocation — a failed `stagereview prep` stays in Prep, because showing
 * "Analyze" for a run that never got a diff is a lie. And the phase is the
 * running maximum, so an agent re-reading a file after writing chapters cannot
 * rewind the rail.
 */
export class PhaseTracker {
	private index = 0;
	private prepToolUseId: string | null = null;

	get phase(): GenerationPhase {
		return GENERATION_PHASE_ORDER[this.index] ?? GENERATION_PHASE.PREP;
	}

	observeToolUse(toolUseId: string, name: string, input: unknown): void {
		if (name === "Write" || name === "Edit") {
			const parsed = FilePathInput.safeParse(input);
			if (parsed.success && AGENT_OUTPUT_PATH.test(parsed.data.file_path)) {
				this.advanceTo(GENERATION_PHASE.WRITE);
			}
			return;
		}
		if (name !== "Bash") return;
		const parsed = CommandInput.safeParse(input);
		if (!parsed.success) return;
		const { command } = parsed.data;

		if (invokesSubcommand(command, STAGEREVIEW, "prep")) this.prepToolUseId = toolUseId;
		if (AGENT_OUTPUT_HEREDOC.test(command)) this.advanceTo(GENERATION_PHASE.WRITE);
		if (invokesSubcommand(command, STAGEREVIEW, "import")) {
			this.advanceTo(GENERATION_PHASE.IMPORT);
		}
	}

	observeToolResult(toolUseId: string, isError: boolean): void {
		if (toolUseId !== this.prepToolUseId || isError) return;
		this.advanceTo(GENERATION_PHASE.ANALYZE);
	}

	private advanceTo(phase: GenerationPhase): void {
		this.index = Math.max(this.index, GENERATION_PHASE_ORDER.indexOf(phase));
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/phase-tracker.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/generation.ts packages/cli/src/generation/phase-tracker.ts packages/cli/src/__tests__/phase-tracker.test.ts
git commit -m "feat: track generation phase from the agent tool stream"
```

---

## Task 5: Progress wire types

**Files:**
- Modify: `packages/types/src/generation.ts`

- [ ] **Step 1: Add the activity and progress schemas**

Append to `packages/types/src/generation.ts`:

```ts
export const ACTIVITY_STATE = {
	RUNNING: "running",
	DONE: "done",
	FAILED: "failed",
} as const;
export type ActivityState = (typeof ACTIVITY_STATE)[keyof typeof ACTIVITY_STATE];

export const ActivityEntrySchema = z.object({
	tool: z.string(),
	/** Sanitized and length-capped by the server; safe to render directly. */
	target: z.string(),
	state: z.enum(ACTIVITY_STATE),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/** How many activity entries the server retains and sends. */
export const ACTIVITY_LIMIT = 20;

export const JobProgressSchema = z.object({
	/** Epoch ms, set when the child process spawns. */
	startedAt: z.number(),
	/**
	 * The model the CLI actually resolved, from the init event. Null for the
	 * first seconds of a run — use the job's requestedModel until it arrives.
	 */
	resolvedModel: z.string().nullable(),
	turns: z.number(),
	phase: z.enum(GENERATION_PHASE),
	/** Oldest first, at most ACTIVITY_LIMIT entries. */
	activity: z.array(ActivityEntrySchema),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;
```

- [ ] **Step 2: Widen `GenerationJobSchema`**

Replace the existing `GenerationJobSchema` in the same file with:

```ts
/** What GET /api/generate/:jobId returns — the public face of a generation job. */
export const GenerationJobSchema = z.object({
	id: z.string(),
	/** Canonical PR URL, so the dashboard can match a job to a row. */
	prUrl: z.string(),
	status: z.enum(JOB_STATUS),
	/** Known at enqueue time, so it is present even while queued. */
	requestedModel: z.enum(GENERATION_MODEL),
	/** Set once the job succeeds. */
	runId: z.string().nullable(),
	error: z.string().nullable(),
	/** 1-based place in line while queued; null when running or terminal. */
	queuePosition: z.number().nullable(),
	/** Null while queued, and for a job whose process never spawned. */
	progress: JobProgressSchema.nullable(),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

/** What GET /api/generate returns — every job that has not reached a terminal status. */
export const ActiveGenerationJobsSchema = z.object({ jobs: z.array(GenerationJobSchema) });
export type ActiveGenerationJobs = z.infer<typeof ActiveGenerationJobsSchema>;
```

- [ ] **Step 3: Typecheck to see the breakage this creates**

Run: `pnpm typecheck`
Expected: FAIL in `packages/cli/src/generation/job-manager.ts` and `packages/cli/src/routes/generate.ts` — `Job` no longer satisfies `GenerationJob` (missing `prUrl`, `requestedModel`, `progress`). Tasks 6-9 close this; the repo is intentionally red between here and Task 9.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/generation.ts
git commit -m "feat: add progress fields to the generation job wire type"
```

---

## Task 6: Stream event schemas

**Files:**
- Create: `packages/cli/src/generation/stream-events.ts`
- Create: `packages/cli/src/__tests__/stream-events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/stream-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { errorResultMessage, parseStreamEvent } from "../generation/stream-events.js";

describe("parseStreamEvent", () => {
	it("parses an init event", () => {
		const parsed = parseStreamEvent({ type: "system", subtype: "init", model: "claude-sonnet-5" });
		expect(parsed).toEqual({
			outcome: "event",
			event: { type: "system", subtype: "init", model: "claude-sonnet-5" },
		});
	});

	it("parses an assistant event with a tool_use block", () => {
		const parsed = parseStreamEvent({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }] },
		});
		expect(parsed.outcome).toBe("event");
	});

	it("treats an unknown event type as unknown, not invalid", () => {
		expect(parseStreamEvent({ type: "stream_event", delta: {} }).outcome).toBe("unknown");
	});

	it("treats a known event with a broken payload as invalid", () => {
		expect(parseStreamEvent({ type: "assistant", message: "nope" }).outcome).toBe("invalid");
	});

	it("rejects a success result with no result text", () => {
		expect(parseStreamEvent({ type: "result", subtype: "success", num_turns: 3 }).outcome).toBe(
			"invalid",
		);
	});

	it("accepts a success result with result text", () => {
		const parsed = parseStreamEvent({
			type: "result",
			subtype: "success",
			result: "done\nabc",
			num_turns: 3,
		});
		expect(parsed.outcome).toBe("event");
	});

	it("accepts an error result with no result field", () => {
		const parsed = parseStreamEvent({
			type: "result",
			subtype: "error_max_turns",
			is_error: true,
			num_turns: 40,
		});
		expect(parsed.outcome).toBe("event");
	});
});

describe("errorResultMessage", () => {
	it("prefers the errors array", () => {
		expect(
			errorResultMessage({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["first", "second"],
			}),
		).toBe("first; second");
	});

	it("falls back to the error string", () => {
		expect(
			errorResultMessage({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				error: "exploded",
			}),
		).toBe("exploded");
	});

	it("falls back to a phrase for a known subtype", () => {
		expect(
			errorResultMessage({ type: "result", subtype: "error_max_turns", is_error: true }),
		).toBe("The agent hit its turn limit.");
	});

	it("falls back to the subtype itself when unrecognized", () => {
		expect(errorResultMessage({ type: "result", subtype: "error_weird", is_error: true })).toBe(
			"Agent failed: error_weird",
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/stream-events.test.ts`
Expected: FAIL — cannot resolve `../generation/stream-events.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/generation/stream-events.ts`:

```ts
import { z } from "zod";
import { sanitizeText } from "./describe-tool-use.js";

const ToolUseBlockSchema = z.object({
	type: z.literal("tool_use"),
	id: z.string(),
	name: z.string(),
	input: z.unknown(),
});
const ToolResultBlockSchema = z.object({
	type: z.literal("tool_result"),
	tool_use_id: z.string(),
	is_error: z.boolean().optional(),
});
/** Text, thinking, and anything the wire format grows later. */
const OtherBlockSchema = z.object({ type: z.string() });

const ContentBlockSchema = z.union([
	ToolUseBlockSchema,
	ToolResultBlockSchema,
	OtherBlockSchema,
]);
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

const InitEventSchema = z.object({
	type: z.literal("system"),
	subtype: z.literal("init"),
	model: z.string(),
});

/**
 * `parent_tool_use_id` is non-null for subagent traffic. Those messages are not
 * top-level turns and their tools are not the main agent's work.
 */
const MessageEventSchema = z.object({
	parent_tool_use_id: z.string().nullish(),
	message: z.object({ content: z.array(ContentBlockSchema) }),
});
const AssistantEventSchema = MessageEventSchema.extend({ type: z.literal("assistant") });
const UserEventSchema = MessageEventSchema.extend({ type: z.literal("user") });

/**
 * A plain union, not a discriminated one: `result` exists only on the success
 * variant, so `{ subtype: "success" }` with no text must fail validation rather
 * than parse into a success with a missing field. Failing here routes it to the
 * "exited without a result event" path instead of an internal null check.
 */
const SuccessResultSchema = z.object({
	type: z.literal("result"),
	subtype: z.literal("success"),
	result: z.string(),
	num_turns: z.number().optional(),
});
const ErrorResultSchema = z.object({
	type: z.literal("result"),
	subtype: z.string(),
	is_error: z.literal(true),
	error: z.string().optional(),
	errors: z.array(z.string()).optional(),
	num_turns: z.number().optional(),
});
const ResultEventSchema = z.union([SuccessResultSchema, ErrorResultSchema]);

export type SuccessResultEvent = z.infer<typeof SuccessResultSchema>;
export type ErrorResultEvent = z.infer<typeof ErrorResultSchema>;
export type ResultEvent = z.infer<typeof ResultEventSchema>;
export type StreamEvent =
	| z.infer<typeof InitEventSchema>
	| z.infer<typeof AssistantEventSchema>
	| z.infer<typeof UserEventSchema>
	| ResultEvent;

export function isSuccessResult(event: ResultEvent): event is SuccessResultEvent {
	return event.subtype === "success";
}

const EVENT_SCHEMAS = {
	system: InitEventSchema,
	assistant: AssistantEventSchema,
	user: UserEventSchema,
	result: ResultEventSchema,
} as const;

const TypedSchema = z.object({ type: z.string() });

/**
 * Three outcomes, deliberately distinct:
 *
 * - `unknown` — an event type we don't model. Ignored, because the wire format
 *   gains variants and a new one must not fail a run.
 * - `invalid` — a type we *do* model whose payload is broken. Counted as a
 *   dropped line, so a corrupt stream is visible in any failure message.
 * - `event` — usable.
 */
export type ParseOutcome =
	| { outcome: "event"; event: StreamEvent }
	| { outcome: "unknown" }
	| { outcome: "invalid" };

export function parseStreamEvent(raw: unknown): ParseOutcome {
	const typed = TypedSchema.safeParse(raw);
	if (!typed.success) return { outcome: "invalid" };
	// `system` covers more subtypes than init; only init carries the model.
	if (typed.data.type === "system") {
		const init = InitEventSchema.safeParse(raw);
		return init.success ? { outcome: "event", event: init.data } : { outcome: "unknown" };
	}
	const schema = EVENT_SCHEMAS[typed.data.type as keyof typeof EVENT_SCHEMAS] ?? null;
	if (schema === null) return { outcome: "unknown" };
	const parsed = schema.safeParse(raw);
	return parsed.success ? { outcome: "event", event: parsed.data } : { outcome: "invalid" };
}

const SUBTYPE_PHRASES: Readonly<Record<string, string>> = {
	error_max_turns: "The agent hit its turn limit.",
	error_during_execution: "The agent errored during execution.",
};

/**
 * Error results carry no final text — `result` is success-only — so the message
 * is assembled from whatever diagnostic fields the event does have.
 */
export function errorResultMessage(event: ErrorResultEvent): string {
	const joined = event.errors?.map(sanitizeText).filter((line) => line !== "").join("; ");
	if (joined !== undefined && joined !== "") return joined;
	const single = event.error === undefined ? "" : sanitizeText(event.error);
	if (single !== "") return single;
	return SUBTYPE_PHRASES[event.subtype] ?? `Agent failed: ${sanitizeText(event.subtype)}`;
}
```

Note on the one type assertion: `EVENT_SCHEMAS[typed.data.type as keyof typeof EVENT_SCHEMAS]` narrows an arbitrary string to the map's key union, and the `?? null` immediately handles the miss. AGENTS.md forbids assertions used to *narrow a value*; this narrows an index type with the miss handled explicitly. If you prefer to avoid it entirely, replace the lookup with an explicit `switch (typed.data.type)` over `"assistant" | "user" | "result"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/stream-events.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/generation/stream-events.ts packages/cli/src/__tests__/stream-events.test.ts
git commit -m "feat: add stream-json event schemas"
```

---

## Task 7: `StreamReducer`

**Files:**
- Create: `packages/cli/src/generation/stream-reducer.ts`
- Create: `packages/cli/src/__tests__/stream-reducer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/stream-reducer.test.ts`:

```ts
import { ACTIVITY_LIMIT, GENERATION_PHASE } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { StreamReducer } from "../generation/stream-reducer.js";

const REPO_ROOT = "/repo";
const STARTED_AT = 1_700_000_000_000;

function reducer(): StreamReducer {
	return new StreamReducer(REPO_ROOT, STARTED_AT);
}

function assistantWithTools(
	tools: Array<{ id: string; name: string; input: unknown }>,
	parentToolUseId: string | null = null,
): string {
	return JSON.stringify({
		type: "assistant",
		parent_tool_use_id: parentToolUseId,
		message: { content: tools.map((tool) => ({ type: "tool_use", ...tool })) },
	});
}

function toolResult(toolUseId: string, isError: boolean): string {
	return JSON.stringify({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
	});
}

describe("StreamReducer", () => {
	it("starts with an empty snapshot at the given time", () => {
		expect(reducer().snapshot()).toEqual({
			startedAt: STARTED_AT,
			resolvedModel: null,
			turns: 0,
			phase: GENERATION_PHASE.PREP,
			activity: [],
		});
	});

	it("records the resolved model from init", () => {
		const r = reducer();
		r.consumeLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5" }));
		expect(r.snapshot().resolvedModel).toBe("claude-sonnet-5");
	});

	it("counts one turn per assistant message, not per tool block", () => {
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
				{ id: "t2", name: "Read", input: { file_path: "/repo/b.ts" } },
			]),
		);
		expect(r.snapshot().turns).toBe(1);
		expect(r.snapshot().activity).toHaveLength(2);
	});

	it("excludes subagent messages from turns and activity", () => {
		const r = reducer();
		r.consumeLine(assistantWithTools([{ id: "t1", name: "Read", input: {} }], "parent-1"));
		expect(r.snapshot()).toMatchObject({ turns: 0, activity: [] });
	});

	it("marks an entry done or failed by tool_use_id", () => {
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
				{ id: "t2", name: "Read", input: { file_path: "/repo/b.ts" } },
			]),
		);
		r.consumeLine(toolResult("t1", false));
		r.consumeLine(toolResult("t2", true));
		expect(r.snapshot().activity.map((entry) => entry.state)).toEqual(["done", "failed"]);
	});

	it("ignores a result for an entry evicted from the ring", () => {
		const r = reducer();
		for (let i = 0; i < ACTIVITY_LIMIT + 1; i += 1) {
			r.consumeLine(assistantWithTools([{ id: `t${i}`, name: "Read", input: {} }]));
		}
		r.consumeLine(toolResult("t0", false));
		const { activity } = r.snapshot();
		expect(activity).toHaveLength(ACTIVITY_LIMIT);
		expect(activity.every((entry) => entry.state !== "done")).toBe(true);
	});

	it("advances the phase through the tracker", () => {
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Bash", input: { command: "PREP_FILE=$(stagereview prep)" } },
			]),
		);
		r.consumeLine(toolResult("t1", false));
		expect(r.snapshot().phase).toBe(GENERATION_PHASE.ANALYZE);
	});

	it("counts malformed JSON without throwing", () => {
		const r = reducer();
		r.consumeLine("not json at all");
		r.consumeLine("");
		expect(r.droppedLines).toBe(1);
		expect(r.snapshot().turns).toBe(0);
	});

	it("counts a known event with a broken payload", () => {
		const r = reducer();
		r.consumeLine(JSON.stringify({ type: "assistant", message: "nope" }));
		expect(r.droppedLines).toBe(1);
	});

	it("does not count an unknown event type", () => {
		const r = reducer();
		r.consumeLine(JSON.stringify({ type: "stream_event", delta: {} }));
		expect(r.droppedLines).toBe(0);
	});

	it("records the result and takes its canonical turn count", () => {
		const r = reducer();
		r.consumeLine(assistantWithTools([{ id: "t1", name: "Read", input: {} }]));
		r.consumeLine(
			JSON.stringify({ type: "result", subtype: "success", result: "abc", num_turns: 17 }),
		);
		expect(r.result?.subtype).toBe("success");
		expect(r.snapshot().turns).toBe(17);
	});

	it("returns a snapshot later mutations do not touch", () => {
		const r = reducer();
		r.consumeLine(assistantWithTools([{ id: "t1", name: "Read", input: {} }]));
		const before = r.snapshot();
		r.consumeLine(toolResult("t1", false));
		expect(before.activity[0]?.state).toBe("running");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/stream-reducer.test.ts`
Expected: FAIL — cannot resolve `../generation/stream-reducer.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/generation/stream-reducer.ts`:

```ts
import {
	ACTIVITY_LIMIT,
	ACTIVITY_STATE,
	type ActivityEntry,
	type JobProgress,
} from "@stagereview/types/generation";
import { describeToolUse } from "./describe-tool-use.js";
import { PhaseTracker } from "./phase-tracker.js";
import { parseStreamEvent, type ResultEvent } from "./stream-events.js";

interface MutableActivityEntry {
	tool: string;
	target: string;
	state: ActivityEntry["state"];
}

/**
 * Folds raw stdout lines into a progress snapshot.
 *
 * It owns JSON parsing and validation, not just the fold: a reducer handed
 * pre-parsed events could not count the parse failures it never saw, and
 * AgentSession's "process I/O only" boundary would be fiction.
 */
export class StreamReducer {
	private readonly phases = new PhaseTracker();
	private readonly activity: MutableActivityEntry[] = [];
	private readonly entryByToolUseId = new Map<string, MutableActivityEntry>();
	private resolvedModel: string | null = null;
	private turns = 0;
	private dropped = 0;
	private terminalResult: ResultEvent | null = null;

	constructor(
		private readonly repoRoot: string,
		private readonly startedAt: number,
	) {}

	get droppedLines(): number {
		return this.dropped;
	}

	/** The terminal result event, if one has arrived. AgentSession settles on it. */
	get result(): ResultEvent | null {
		return this.terminalResult;
	}

	consumeLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let raw: unknown;
		try {
			raw = JSON.parse(trimmed);
		} catch {
			this.dropped += 1;
			return;
		}
		const parsed = parseStreamEvent(raw);
		if (parsed.outcome === "invalid") {
			this.dropped += 1;
			return;
		}
		if (parsed.outcome === "unknown") return;

		const { event } = parsed;
		switch (event.type) {
			case "system":
				this.resolvedModel = event.model;
				return;
			case "assistant": {
				// Subagent traffic is not a top-level turn and not the main agent's work.
				if (event.parent_tool_use_id != null) return;
				this.turns += 1;
				for (const block of event.message.content) {
					if (block.type !== "tool_use" || !("id" in block)) continue;
					this.phases.observeToolUse(block.id, block.name, block.input);
					const entry = this.push({
						...describeToolUse(block.name, block.input, this.repoRoot),
						state: ACTIVITY_STATE.RUNNING,
					});
					this.entryByToolUseId.set(block.id, entry);
				}
				return;
			}
			case "user": {
				if (event.parent_tool_use_id != null) return;
				for (const block of event.message.content) {
					if (block.type !== "tool_result" || !("tool_use_id" in block)) continue;
					const isError = block.is_error === true;
					this.phases.observeToolResult(block.tool_use_id, isError);
					const entry = this.entryByToolUseId.get(block.tool_use_id);
					if (entry === undefined) continue;
					entry.state = isError ? ACTIVITY_STATE.FAILED : ACTIVITY_STATE.DONE;
				}
				return;
			}
			case "result":
				this.terminalResult = event;
				if (event.num_turns !== undefined) this.turns = event.num_turns;
				return;
		}
	}

	/** A deep copy — the ring is mutable and callers must not observe it changing. */
	snapshot(): JobProgress {
		return {
			startedAt: this.startedAt,
			resolvedModel: this.resolvedModel,
			turns: this.turns,
			phase: this.phases.phase,
			activity: this.activity.map((entry) => ({ ...entry })),
		};
	}

	/** Appends to the ring, evicting the oldest entry and its correlation key. */
	private push(entry: MutableActivityEntry): MutableActivityEntry {
		if (this.activity.length === ACTIVITY_LIMIT) {
			const evicted = this.activity.shift();
			if (evicted !== undefined) {
				for (const [id, candidate] of this.entryByToolUseId) {
					if (candidate === evicted) this.entryByToolUseId.delete(id);
				}
			}
		}
		this.activity.push(entry);
		return entry;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/stream-reducer.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/generation/stream-reducer.ts packages/cli/src/__tests__/stream-reducer.test.ts
git commit -m "feat: fold agent stream events into a progress snapshot"
```

---

## Task 8: `AgentSession` and the settlement state machine

The riskiest task. `execFile` handled process lifecycle for us; `spawn` does not.

**Files:**
- Create: `packages/cli/src/generation/run-id.ts`
- Create: `packages/cli/src/generation/agent-session.ts`
- Create: `packages/cli/src/__tests__/fake-child-process.ts`
- Create: `packages/cli/src/__tests__/agent-session.test.ts`

- [ ] **Step 1: Move `parseRunnerOutput` to its own module**

`agent-session.ts` needs the runId parser, and `job-manager.ts` needs
`AgentSession`. Leaving the parser in `job-manager.ts` would make that a runtime
import cycle. Give it its own module instead; the type-only `JobRequest` import
in the other direction is erased at build time, so nothing circular remains.

Create `packages/cli/src/generation/run-id.ts` with the current body of
`parseRunnerOutput` from `job-manager.ts:136-157`, minus the leaked line, and
with its own `runIdSchema`:

```ts
import { z } from "zod";

const runIdSchema = z.string().uuid();

/**
 * The runId the agent was told to print as its last line. Throws when the agent
 * ended on anything else — a missing or malformed runId means the run didn't
 * land in the database, so failing loudly beats surfacing a bogus link.
 *
 * The offending line is deliberately NOT quoted back: under stream-json it is
 * the tail of the agent's final prose, which can contain source or file
 * contents.
 */
export function parseRunnerOutput(stdout: string): string {
	const lines = stdout.trim().split("\n");
	const lastLine = lines[lines.length - 1]?.trim() ?? "";
	const parsed = runIdSchema.safeParse(lastLine);
	if (!parsed.success) throw new Error("Agent did not return a valid runId.");
	return parsed.data;
}
```

Delete `runIdSchema`, `parseRunnerOutput`, and the now-unused `import { z }` from
`job-manager.ts`, and re-export so the existing test import keeps resolving:

```ts
export { parseRunnerOutput } from "./run-id.js";
```

The message change breaks an existing assertion, so update it now. In
`packages/cli/src/__tests__/job-manager.test.ts`, replace the whole
`describe("parseRunnerOutput", …)` block with:

```ts
describe("parseRunnerOutput", () => {
	it("takes the runId from the agent's last line", () => {
		const runId = randomUUID();
		expect(parseRunnerOutput(`Generated 4 chapters.\nWrote chapters.json\n${runId}\n`)).toBe(runId);
	});

	it("rejects a last line that is not a runId without echoing it", () => {
		// Under stream-json this line is the tail of the agent's prose, which can
		// quote source or file contents — it must not reach an error message.
		expect(() => parseRunnerOutput("Here is the secret token abc123.\n")).toThrow(
			"Agent did not return a valid runId.",
		);
		expect(() => parseRunnerOutput("Here is the secret token abc123.\n")).not.toThrow(
			/abc123/,
		);
	});

	it("rejects a 36-character non-UUID", () => {
		expect(() => parseRunnerOutput("-".repeat(36))).toThrow(/valid runId/);
	});

	it("rejects empty output", () => {
		expect(() => parseRunnerOutput("   \n")).toThrow(/valid runId/);
	});
});
```

- [ ] **Step 2: Write the fake child process helper**

Create `packages/cli/src/__tests__/fake-child-process.ts`:

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * The narrow slice of ChildProcess that AgentSession uses, so a test can drive
 * a run without launching anything.
 */
export class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: Array<NodeJS.Signals | number> = [];

	// Signature must match ChildProcess.kill, or FakeChild isn't assignable to
	// SpawnedChild.
	kill(signal?: NodeJS.Signals | number): boolean {
		this.signals.push(signal ?? "SIGTERM");
		return true;
	}

	/** Writes one NDJSON line to stdout. */
	emitLine(event: unknown): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	/** Ends the streams and fires `close`, the only event that settles a run. */
	close(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code, signal);
	}
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/__tests__/agent-session.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { GENERATION_MODEL, type JobProgress } from "@stagereview/types/generation";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../generation/agent-session.js";
import type { JobRequest } from "../generation/job-manager.js";
import { FakeChild } from "./fake-child-process.js";

const JOB: JobRequest = {
	prUrl: "https://github.com/acme/widgets/pull/42",
	repoRoot: "/repo",
	requestedModel: GENERATION_MODEL.SONNET,
};

const TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 100;
const ERROR_GRACE_MS = 50;

function makeSession(child: FakeChild, onProgress: (p: JobProgress) => void = () => {}) {
	return new AgentSession({
		job: JOB,
		onProgress,
		now: () => 1_700_000_000_000,
		spawnChild: () => child,
		timeoutMs: TIMEOUT_MS,
		killGraceMs: KILL_GRACE_MS,
		errorGraceMs: ERROR_GRACE_MS,
	});
}

/** Lets queued microtasks and stream reads flush. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function successResult(runId: string) {
	return { type: "result", subtype: "success", result: `Done.\n${runId}`, num_turns: 5 };
}

describe("AgentSession settlement", () => {
	it("resolves with the runId only after close", async () => {
		const runId = randomUUID();
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(runId));
		await flush();

		let settled = false;
		void run.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false); // result alone must not settle

		child.close(0);
		await expect(run).resolves.toBe(runId);
	});

	it("pushes a first snapshot immediately after spawn", async () => {
		const child = new FakeChild();
		const snapshots: JobProgress[] = [];
		const session = makeSession(child, (p) => snapshots.push(p));
		const run = session.run();
		child.emit("spawn");
		await flush();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ resolvedModel: null, turns: 0, phase: "prep" });

		child.close(1);
		await expect(run).rejects.toThrow();
	});

	it("rejects on a spawn error followed by close, settling once", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("error", new Error("spawn claude ENOENT"));
		child.close(null);
		await expect(run).rejects.toThrow(/ENOENT/);
	});

	it("rejects a pre-spawn error that never closes, via the grace period", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("error", new Error("spawn claude EACCES"));
		await expect(run).rejects.toThrow(/EACCES/);
	});

	it("stays pending on a post-spawn error that never closes", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emit("error", new Error("kill ESRCH"));

		let settled = false;
		void run.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, ERROR_GRACE_MS * 3));
		expect(settled).toBe(false); // releasing the queue here could start a second agent
		expect(child.signals).toContain("SIGKILL");

		child.close(null, "SIGKILL");
		await expect(run).rejects.toThrow();
	});

	it("rejects when the process exits cleanly with no result event", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.close(0);
		await expect(run).rejects.toThrow(/without a result event/);
	});

	it("rejects a success result followed by a non-zero close", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(randomUUID()));
		await flush();
		child.close(3);
		await expect(run).rejects.toThrow(/exited with code 3/);
	});

	it("rejects when terminated by a signal we did not send", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.close(null, "SIGSEGV");
		await expect(run).rejects.toThrow(/SIGSEGV/);
	});

	it("settles once when two result events arrive", async () => {
		const runId = randomUUID();
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(runId));
		child.emitLine(successResult(randomUUID()));
		await flush();
		child.close(0);
		await expect(run).resolves.toBe(runId); // the first result wins
	});

	it("reports an error result using its diagnostic fields", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine({ type: "result", subtype: "error_max_turns", is_error: true });
		await flush();
		child.close(0);
		await expect(run).rejects.toThrow(/hit its turn limit/);
	});

	it("rejects when the final line is not a runId, without echoing it", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine({ type: "result", subtype: "success", result: "Here is your secret token." });
		await flush();
		child.close(0);
		await expect(run).rejects.toThrow("Agent did not return a valid runId.");
		await expect(run).rejects.not.toThrow(/secret token/);
	});

	it("mentions dropped lines in a failure message", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.stdout.write("{ not json\n");
		await flush();
		child.close(0);
		await expect(run).rejects.toThrow(/1 unreadable line/);
	});
});

describe("AgentSession timeout", () => {
	it("escalates SIGTERM to SIGKILL and stays pending until close", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			const session = makeSession(child);
			const run = session.run();
			let settled = false;
			void run.catch(() => {
				settled = true;
			});
			child.emit("spawn");

			await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
			expect(child.signals).toEqual(["SIGTERM"]);
			expect(settled).toBe(false);

			await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
			expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(settled).toBe(false); // still alive — the queue must not advance

			child.close(null, "SIGKILL");
			await expect(run).rejects.toThrow(/timed out/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a timeout, not a signal, when the child dies from our SIGTERM", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			const session = makeSession(child);
			const run = session.run();
			const assertion = expect(run).rejects.toThrow(/timed out/);
			child.emit("spawn");
			await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
			child.close(null, "SIGTERM");
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/agent-session.test.ts`
Expected: FAIL — cannot resolve `../generation/agent-session.js`.

- [ ] **Step 4: Implement**

Create `packages/cli/src/generation/agent-session.ts`:

```ts
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { JobProgress } from "@stagereview/types/generation";
import { sanitizeText } from "./describe-tool-use.js";
import type { JobRequest } from "./job-manager.js";
import { errorResultMessage, isSuccessResult } from "./stream-events.js";
import { StreamReducer } from "./stream-reducer.js";

export const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
/** How long a SIGTERM gets before we escalate. */
export const KILL_GRACE_MS = 10 * 1000;
/** How long a pre-spawn error waits for a `close` that may never come. */
export const ERROR_GRACE_MS = 1_000;
/** Nobody is at the keyboard to answer tool prompts, and this daemon only ever runs on the user's own machine against their own clones. */
const PERMISSION_MODE = "bypassPermissions";
/** Lines of stderr kept for failure messages, and the cap on the terminal tee. */
const STDERR_TAIL_LINES = 5;
const STDERR_TEE_LINES = 200;
const STDERR_LINE_LIMIT = 200;

/** The slice of ChildProcess this class uses — narrowed so tests can fake it. */
export type SpawnedChild = Pick<ChildProcess, "kill"> &
	EventEmitter & {
		stdout: NodeJS.ReadableStream | null;
		stderr: NodeJS.ReadableStream | null;
	};

export interface AgentSessionOptions {
	readonly job: JobRequest;
	readonly onProgress: (progress: JobProgress) => void;
	readonly now: () => number;
	readonly spawnChild: (job: JobRequest) => SpawnedChild;
	readonly timeoutMs: number;
	readonly killGraceMs: number;
	readonly errorGraceMs: number;
}

function promptFor(prUrl: string): string {
	return [
		`/stage-chapters --pr ${prUrl}`,
		"IMPORTANT: this is a headless run for the Stage dashboard.",
		"In the final step, run `stagereview import` (same arguments as `show`) instead of `stagereview show`,",
		"and print ONLY the runId it outputs as your last line.",
	].join("\n");
}

/** The real spawn: headless claude emitting its event stream on stdout. */
export function spawnClaude(job: JobRequest): SpawnedChild {
	return spawn(
		"claude",
		[
			"-p",
			promptFor(job.prUrl),
			"--model",
			job.requestedModel,
			"--permission-mode",
			PERMISSION_MODE,
			"--output-format",
			"stream-json",
			"--verbose",
		],
		{ cwd: job.repoRoot, stdio: ["ignore", "pipe", "pipe"] },
	);
}

/**
 * One headless agent process, plus everything needed to watch it.
 *
 * `run()` settles exactly once, and only on `close`. That is a queue-safety
 * requirement rather than tidiness: JobManager.drain() awaits this promise, so
 * settling while the child is still alive would start the next agent against a
 * worktree the previous one may still be writing.
 */
export class AgentSession {
	private readonly reducer: StreamReducer;
	private readonly options: AgentSessionOptions;
	private readonly stderrTail: string[] = [];
	private stderrTeed = 0;
	private settled = false;
	private spawned = false;
	private timedOut = false;
	private spawnError: Error | null = null;
	private timeoutTimer: NodeJS.Timeout | null = null;
	private killTimer: NodeJS.Timeout | null = null;
	private errorTimer: NodeJS.Timeout | null = null;

	constructor(options: AgentSessionOptions) {
		this.options = options;
		this.reducer = new StreamReducer(options.job.repoRoot, options.now());
	}

	private get tag(): string {
		return `[stage:generate] ${this.options.job.prUrl}`;
	}

	run(): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const child = this.options.spawnChild(this.options.job);

			const settle = (outcome: () => void) => {
				if (this.settled) return;
				this.settled = true;
				this.clearTimers();
				outcome();
			};

			child.on("spawn", () => {
				this.spawned = true;
				// Without this first push, progress stays null until the init event
				// lands seconds later and a running job looks queued.
				this.options.onProgress(this.reducer.snapshot());
			});

			child.on("error", (err: Error) => {
				this.spawnError = err;
				if (this.spawned) {
					// The process exists and may still hold the worktree. Do not release
					// the queue — escalate, and stay pending if it never closes.
					console.error(`${this.tag} process error after spawn: ${err.message}`);
					child.kill("SIGKILL");
					return;
				}
				// Nothing was ever created, so nothing can be holding the worktree.
				this.errorTimer = setTimeout(() => {
					settle(() => reject(err));
				}, this.options.errorGraceMs);
			});

			child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
				settle(() => {
					const failure = this.failureFor(code, signal);
					if (failure !== null) {
						reject(new Error(this.decorate(failure)));
						return;
					}
					const result = this.reducer.result;
					if (result === null || !isSuccessResult(result)) {
						reject(new Error(this.decorate("agent exited without a usable result")));
						return;
					}
					try {
						resolve(parseRunId(result.result));
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
			});

			if (child.stdout) {
				readline
					.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
					.on("line", (line) => {
						this.reducer.consumeLine(line);
						this.options.onProgress(this.reducer.snapshot());
					});
			}
			if (child.stderr) {
				readline
					.createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY })
					.on("line", (line) => this.recordStderr(line));
			}

			this.timeoutTimer = setTimeout(() => {
				this.timedOut = true;
				console.error(`${this.tag} timed out — sending SIGTERM`);
				child.kill("SIGTERM");
				this.killTimer = setTimeout(() => {
					console.error(`${this.tag} still running — sending SIGKILL`);
					child.kill("SIGKILL");
				}, this.options.killGraceMs);
			}, this.options.timeoutMs);
		});
	}

	/**
	 * The reason this run failed, or null when the process ended cleanly.
	 * Precedence matters: a timeout outranks the signal it caused, because the
	 * signal is only how we killed it.
	 */
	private failureFor(code: number | null, signal: NodeJS.Signals | null): string | null {
		if (this.timedOut) return `agent timed out after ${this.options.timeoutMs}ms`;
		if (this.spawnError !== null) return this.spawnError.message;
		if (code !== null && code !== 0) return `agent exited with code ${code}`;
		if (signal !== null) return `agent terminated by ${signal}`;
		const result = this.reducer.result;
		if (result === null) return "agent exited without a result event";
		if (!isSuccessResult(result)) return errorResultMessage(result);
		return null;
	}

	/** Appends the stderr tail and, when the stream was corrupt, says so. */
	private decorate(message: string): string {
		const parts = [message];
		const dropped = this.reducer.droppedLines;
		if (dropped > 0) {
			parts.push(`(${dropped} unreadable line${dropped === 1 ? "" : "s"} in the agent stream)`);
		}
		if (this.stderrTail.length > 0) parts.push(this.stderrTail.join("\n"));
		return parts.join("\n");
	}

	private recordStderr(line: string): void {
		const clean = sanitizeText(line).slice(0, STDERR_LINE_LIMIT);
		if (clean === "") return;
		this.stderrTail.push(clean);
		if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
		if (this.stderrTeed < STDERR_TEE_LINES) {
			this.stderrTeed += 1;
			console.error(`${this.tag} ${clean}`);
		}
	}

	private clearTimers(): void {
		for (const timer of [this.timeoutTimer, this.killTimer, this.errorTimer]) {
			if (timer !== null) clearTimeout(timer);
		}
		this.timeoutTimer = null;
		this.killTimer = null;
		this.errorTimer = null;
	}
}
```

The runId parser comes from the module created in Step 1 — importing it from
`job-manager.ts` would create a runtime import cycle. Place this with the other
imports at the top:

```ts
import { parseRunnerOutput as parseRunId } from "./run-id.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/__tests__/agent-session.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/generation/run-id.ts packages/cli/src/generation/agent-session.ts packages/cli/src/generation/job-manager.ts packages/cli/src/__tests__/agent-session.test.ts packages/cli/src/__tests__/fake-child-process.ts
git commit -m "feat: add AgentSession with single-settlement process lifecycle"
```

---

## Task 9: Wire `JobManager` to progress

**Files:**
- Modify: `packages/cli/src/generation/job-manager.ts`
- Modify: `packages/cli/src/__tests__/job-manager.test.ts`

- [ ] **Step 1: Add a progress test**

Append to `packages/cli/src/__tests__/job-manager.test.ts`:

```ts
describe("JobManager progress", () => {
	it("exposes the latest snapshot and lists only non-terminal jobs", async () => {
		let push: (progress: JobProgress) => void = () => {};
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = new JobManager(async (_job, onProgress) => {
			push = onProgress;
			await blocked;
			return "run-1";
		});
		const id = manager.enqueue({
			prUrl: "https://github.com/o/r/pull/1",
			repoRoot: "/o",
			model: "sonnet",
		});
		await new Promise((r) => setTimeout(r, 0));

		const progress: JobProgress = {
			startedAt: 1,
			resolvedModel: "claude-sonnet-5",
			turns: 3,
			phase: "analyze",
			activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
		};
		push(progress);
		expect(manager.get(id)?.progress).toEqual(progress);
		expect(manager.get(id)?.requestedModel).toBe("sonnet");
		expect(manager.activeJobs().map((job) => job.id)).toEqual([id]);

		release();
		await manager.settled();
		expect(manager.activeJobs()).toEqual([]);
	});
});
```

Add `import type { JobProgress } from "@stagereview/types/generation";` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/job-manager.test.ts`
Expected: FAIL — `activeJobs` is not a function, and the runner is called with one argument so `onProgress` is undefined.

- [ ] **Step 3: Rewrite `job-manager.ts`**

Replace `packages/cli/src/generation/job-manager.ts` entirely:

```ts
import { randomUUID } from "node:crypto";
import {
	type GenerationJob,
	type GenerationModel,
	isTerminalJobStatus,
	JOB_STATUS,
	type JobProgress,
} from "@stagereview/types/generation";
import {
	AGENT_TIMEOUT_MS,
	AgentSession,
	ERROR_GRACE_MS,
	KILL_GRACE_MS,
	spawnClaude,
} from "./agent-session.js";

export interface JobRequest {
	prUrl: string;
	repoRoot: string;
	model: GenerationModel;
}

export interface Job extends JobRequest, GenerationJob {}

/** Returns the new runId on success. `onProgress` may be called any number of times before then. */
export type JobRunner = (
	job: JobRequest,
	onProgress: (progress: JobProgress) => void,
) => Promise<string>;

/**
 * Runs generation jobs one at a time. Each job spawns a headless agent that is
 * expensive and touches a git worktree, so overlapping runs are never safe —
 * further requests queue behind the one in flight.
 */
export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private readonly queue: Job[] = [];
	private running = false;
	private idle: Promise<void> = Promise.resolve();
	private resolveIdle: () => void = () => {};

	constructor(private readonly runner: JobRunner) {}

	enqueue(request: JobRequest): string {
		// `...request` already supplies prUrl, repoRoot, and requestedModel — the
		// rename in Task 1 is what lets the spread satisfy GenerationJob directly.
		const job: Job = {
			...request,
			id: randomUUID(),
			status: JOB_STATUS.QUEUED,
			runId: null,
			error: null,
			queuePosition: null,
			progress: null,
		};
		this.jobs.set(job.id, job);
		this.queue.push(job);
		if (!this.running) {
			this.idle = new Promise((resolve) => {
				this.resolveIdle = resolve;
			});
			void this.drain();
		}
		return job.id;
	}

	/**
	 * The queued or running job for this PR, if any. Two tabs (or a remounted
	 * row) must not each spawn an agent for the same PR, so callers reuse this
	 * job instead of enqueuing a second one. URLs are compared case-insensitively
	 * — GitHub treats owner/repo as case-insensitive.
	 */
	activeJobFor(prUrl: string): Job | null {
		const wanted = prUrl.toLowerCase();
		for (const job of this.jobs.values()) {
			if (job.prUrl.toLowerCase() === wanted && !isTerminalJobStatus(job.status)) {
				return this.snapshot(job);
			}
		}
		return null;
	}

	/** Every job that has not reached a terminal status — what the dashboard badges. */
	activeJobs(): Job[] {
		const active: Job[] = [];
		for (const job of this.jobs.values()) {
			if (!isTerminalJobStatus(job.status)) active.push(this.snapshot(job));
		}
		return active;
	}

	/**
	 * The most recent job for this PR, any status — unlike activeJobFor, which
	 * skips terminal jobs. The resolver uses this to report `failed` instead of
	 * pretending generation was never attempted. Map preserves insertion order,
	 * so the last match is the newest.
	 */
	latestJobFor(prUrl: string): Job | null {
		const wanted = prUrl.toLowerCase();
		let latest: Job | null = null;
		for (const job of this.jobs.values()) {
			if (job.prUrl.toLowerCase() === wanted) latest = job;
		}
		return latest ? this.snapshot(latest) : null;
	}

	/** A snapshot of the job — callers can't mutate the queue's state through it. */
	get(id: string): Job | null {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job) : null;
	}

	/** 1-based place in line, or null when running or terminal. drain() shifts the running job off the queue, so indexOf is exact. */
	private positionOf(job: Job): number | null {
		const idx = this.queue.indexOf(job);
		return idx >= 0 ? idx + 1 : null;
	}

	private snapshot(job: Job): Job {
		return { ...job, queuePosition: this.positionOf(job) };
	}

	/** Resolves when the queue is empty. For tests and graceful shutdown. */
	settled(): Promise<void> {
		return this.running ? this.idle : Promise.resolve();
	}

	private async drain(): Promise<void> {
		this.running = true;
		let job = this.queue.shift();
		while (job !== undefined) {
			const current = job;
			current.status = JOB_STATUS.RUNNING;
			try {
				current.runId = await this.runner(current, (progress) => {
					current.progress = progress;
				});
				current.status = JOB_STATUS.SUCCEEDED;
			} catch (err) {
				current.status = JOB_STATUS.FAILED;
				current.error = err instanceof Error ? err.message : String(err);
			}
			job = this.queue.shift();
		}
		this.running = false;
		this.resolveIdle();
	}
}

// Re-exported so existing importers (and the job-manager tests) keep resolving
// it here; the implementation lives in run-id.ts to keep agent-session.ts and
// job-manager.ts free of an import cycle.
export { parseRunnerOutput } from "./run-id.js";

/** The real runner: one AgentSession per job. */
export function claudeRunner(
	job: JobRequest,
	onProgress: (progress: JobProgress) => void,
): Promise<string> {
	return new AgentSession({
		job,
		onProgress,
		now: () => Date.now(),
		spawnChild: spawnClaude,
		timeoutMs: AGENT_TIMEOUT_MS,
		killGraceMs: KILL_GRACE_MS,
		errorGraceMs: ERROR_GRACE_MS,
	}).run();
}
```

- [ ] **Step 4: Run the CLI test suite**

Run: `pnpm vitest run packages/cli`
Expected: PASS for `job-manager`, `agent-session`, `stream-reducer`, `phase-tracker`, `bash-commands`, `describe-tool-use`, `stream-events`. `generate.routes.test.ts` may still fail — Task 10 wires the routes.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/generation/job-manager.ts packages/cli/src/__tests__/job-manager.test.ts
git commit -m "feat: track per-job progress in the job manager"
```

---

## Task 10: Serve progress over HTTP

**Files:**
- Modify: `packages/cli/src/routes/generate.ts`
- Create: `packages/cli/src/__tests__/generate-progress.routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/generate-progress.routes.test.ts`:

```ts
import { ActiveGenerationJobsSchema, GenerationJobSchema } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { setupGenerateRoutesTest } from "./generate-route-harness.js";

const PR_URL = "https://github.com/Acme/Widgets/pull/7";

describe("GET /api/generate/:jobId progress", () => {
	const env = setupGenerateRoutesTest();

	it("reports the requested model, prUrl, and live progress", async () => {
		env.blockRunner();
		const start = await fetch(`http://127.0.0.1:${env.port()}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${env.port()}` },
			body: JSON.stringify({ prUrl: PR_URL, model: "opus" }),
		});
		const { jobId } = await start.json();
		env.pushProgress({
			startedAt: 1,
			resolvedModel: "claude-opus-5",
			turns: 4,
			phase: "analyze",
			activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
		});

		const res = await fetch(`http://127.0.0.1:${env.port()}/api/generate/${jobId}`);
		expect(res.status).toBe(200);
		const job = GenerationJobSchema.parse(await res.json());
		expect(job).toMatchObject({
			prUrl: PR_URL,
			requestedModel: "opus",
			status: "running",
			progress: { phase: "analyze", turns: 4, resolvedModel: "claude-opus-5" },
		});

		env.releaseRunner();
		await env.jobs.settled();
	});

	it("keeps the snapshot after the job fails", async () => {
		env.failRunner("boom");
		const start = await fetch(`http://127.0.0.1:${env.port()}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${env.port()}` },
			body: JSON.stringify({ prUrl: PR_URL }),
		});
		const { jobId } = await start.json();
		await env.jobs.settled();

		const res = await fetch(`http://127.0.0.1:${env.port()}/api/generate/${jobId}`);
		const job = GenerationJobSchema.parse(await res.json());
		expect(job.status).toBe("failed");
		expect(job.error).toBe("boom");
		expect(job.progress?.phase).toBe("write");
	});
});

describe("GET /api/generate", () => {
	const env = setupGenerateRoutesTest();

	it("lists non-terminal jobs and drops them once they finish", async () => {
		env.blockRunner();
		const start = await fetch(`http://127.0.0.1:${env.port()}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${env.port()}` },
			body: JSON.stringify({ prUrl: PR_URL }),
		});
		const { jobId } = await start.json();

		const during = ActiveGenerationJobsSchema.parse(
			await (await fetch(`http://127.0.0.1:${env.port()}/api/generate`)).json(),
		);
		expect(during.jobs.map((job) => job.id)).toEqual([jobId]);

		env.releaseRunner();
		await env.jobs.settled();

		const after = ActiveGenerationJobsSchema.parse(
			await (await fetch(`http://127.0.0.1:${env.port()}/api/generate`)).json(),
		);
		expect(after.jobs).toEqual([]);
	});
});
```

- [ ] **Step 2: Extend the shared harness**

In `packages/cli/src/__tests__/generate-route-harness.ts`, add to the `GenerateRoutesEnv` interface:

```ts
	/** Pushes a progress snapshot from inside the currently running job. */
	pushProgress(progress: JobProgress): void;
	/** Makes the next job fail after reporting progress up to the write phase. */
	failRunner(message: string): void;
```

Add `import type { JobProgress } from "@stagereview/types/generation";` to the file's imports.

The two new bindings must live in the `setupGenerateRoutesTest` closure, not
inside `beforeEach`, or the returned methods can't see them. Add them after the
existing `let releaseRunner: () => void = () => {};` (line 45):

```ts
	let pushProgress: (progress: JobProgress) => void = () => {};
	let failure: string | null = null;
```

Reset them in `beforeEach`, right after the existing `releaseRunner = () => {};` line:

```ts
		pushProgress = () => {};
		failure = null;
```

Replace the `jobs = new JobManager(…)` call in `beforeEach` with:

```ts
		jobs = new JobManager(async (job, onProgress) => {
			requested.push(job);
			pushProgress = onProgress;
			if (failure !== null) {
				onProgress({
					startedAt: 1,
					resolvedModel: null,
					turns: 1,
					phase: "write",
					activity: [],
				});
				throw new Error(failure);
			}
			await blocked;
			return "run-abc";
		});
```

Add these two methods to the object returned at the end of the function, next to
`blockRunner` and `releaseRunner`. The inner `pushProgress(progress)` call
resolves to the outer `let`, not to the method — object-literal method names are
not bindings in scope — so this delegates rather than recursing, the same shape
the existing `releaseRunner` method already uses.

```ts
		pushProgress(progress: JobProgress) {
			pushProgress(progress);
		},
		failRunner(message: string) {
			failure = message;
		},
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/__tests__/generate-progress.routes.test.ts`
Expected: FAIL — `GET /api/generate` returns 404, and the single-job response is missing `prUrl` / `requestedModel` / `progress`.

- [ ] **Step 4: Implement the routes**

In `packages/cli/src/routes/generate.ts`, add a serializer above `generateRoutes`:

```ts
/** The public projection of a job — internal fields like repoRoot never ship. */
function toWire(job: Job): GenerationJob {
	const { id, prUrl, status, requestedModel, runId, error, queuePosition, progress } = job;
	return { id, prUrl, status, requestedModel, runId, error, queuePosition, progress };
}
```

Import `type Job` from `../generation/job-manager.js` and `type ActiveGenerationJobs` from `@stagereview/types/generation`.

Replace the `GET /api/generate/:jobId` handler body with:

```ts
				handler: (_req, res, params) => {
					const jobId = params.jobId;
					const job = jobId ? jobs.get(jobId) : null;
					if (!job) {
						writeJson(res, 404, { error: "Job not found" });
						return;
					}
					writeJson(res, 200, toWire(job));
				},
```

Add a third route to the returned array, **before** the `:jobId` route so the literal path is not shadowed by the parameter pattern:

```ts
			{
				method: "GET",
				pattern: "/api/generate",
				handler: (_req, res) => {
					writeJson(res, 200, {
						jobs: jobs.activeJobs().map(toWire),
					} satisfies ActiveGenerationJobs);
				},
			},
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/cli`
Expected: PASS, whole CLI suite.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. The repo is green again from here on.

```bash
git add packages/cli/src/routes/generate.ts packages/cli/src/__tests__
git commit -m "feat: serve generation progress and an active-jobs list"
```

---

## Task 11: Duration formatting and the elapsed hook

**Files:**
- Modify: `packages/web/src/lib/format.ts`
- Create: `packages/web/src/lib/use-elapsed.ts`
- Create: `packages/web/src/lib/generation-labels.ts`
- Create: `packages/web/src/lib/__tests__/format-duration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/__tests__/format-duration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatDurationSeconds } from "../format";

describe("formatDurationSeconds", () => {
	it("formats seconds", () => {
		expect(formatDurationSeconds(42)).toBe("42s");
	});

	it("formats minutes and seconds", () => {
		expect(formatDurationSeconds(102)).toBe("1m 42s");
	});

	it("drops a zero seconds remainder", () => {
		expect(formatDurationSeconds(120)).toBe("2m");
	});

	it("formats hours", () => {
		expect(formatDurationSeconds(3_900)).toBe("1h 5m");
	});

	it("returns null for a negative or non-finite duration", () => {
		expect(formatDurationSeconds(-1)).toBeNull();
		expect(formatDurationSeconds(Number.NaN)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/web/src/lib/__tests__/format-duration.test.ts`
Expected: FAIL — `formatDurationSeconds` is not exported.

- [ ] **Step 3: Extract the formatter**

Replace `formatElapsedTime` in `packages/web/src/lib/format.ts` with:

```ts
/** Compact duration, e.g. "42s", "1m 12s", "1h 5m". Null when not a sane duration. */
export function formatDurationSeconds(seconds: number): string | null {
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	const whole = Math.round(seconds);
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	const remainingSeconds = whole % 60;
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** Compact elapsed time between two ISO timestamps, e.g. "1m 12s". */
export function formatElapsedTime(
	startedAt: string | null,
	completedAt: string | null,
): string | null {
	if (!startedAt || !completedAt) return null;
	return formatDurationSeconds(
		(new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000,
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/web/src/lib/__tests__/format-duration.test.ts && pnpm vitest run packages/web`
Expected: PASS, including the existing `formatElapsedTime` callers.

- [ ] **Step 5: Add the elapsed hook**

Create `packages/web/src/lib/use-elapsed.ts`:

```ts
import { useEffect, useState } from "react";

const TICK_MS = 1_000;

/**
 * Seconds since `startedAt`, ticking once a second. A genuine subscription to
 * an external clock, not derived state — the value changes with wall time, not
 * with props.
 */
export function useElapsedSeconds(startedAt: number | null): number | null {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (startedAt === null) return;
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, [startedAt]);

	return startedAt === null ? null : Math.max(0, (now - startedAt) / 1000);
}
```

- [ ] **Step 6: Add the display labels**

Create `packages/web/src/lib/generation-labels.ts`:

```ts
import {
	ACTIVITY_STATE,
	type ActivityState,
	GENERATION_PHASE,
	type GenerationPhase,
} from "@stagereview/types/generation";

export const PHASE_LABELS: Readonly<Record<GenerationPhase, string>> = {
	[GENERATION_PHASE.PREP]: "Prep the diff",
	[GENERATION_PHASE.ANALYZE]: "Read & analyze",
	[GENERATION_PHASE.WRITE]: "Write chapters",
	[GENERATION_PHASE.IMPORT]: "Import",
};

/** Short form for a dashboard row, where the full label doesn't fit. */
export const PHASE_BADGES: Readonly<Record<GenerationPhase, string>> = {
	[GENERATION_PHASE.PREP]: "Prep",
	[GENERATION_PHASE.ANALYZE]: "Analyze",
	[GENERATION_PHASE.WRITE]: "Write",
	[GENERATION_PHASE.IMPORT]: "Import",
};

/** Accessible names for the state glyphs — the icon is never the only signal. */
export const ACTIVITY_STATE_LABELS: Readonly<Record<ActivityState, string>> = {
	[ACTIVITY_STATE.RUNNING]: "Running",
	[ACTIVITY_STATE.DONE]: "Done",
	[ACTIVITY_STATE.FAILED]: "Failed",
};
```

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/format.ts packages/web/src/lib/use-elapsed.ts packages/web/src/lib/generation-labels.ts packages/web/src/lib/__tests__/format-duration.test.ts
git commit -m "feat: add duration formatting, elapsed hook, and generation labels"
```

---

## Task 12: Resolver view carries the snapshot

**Files:**
- Modify: `packages/web/src/lib/resolver-view.ts:15-74`
- Modify: `packages/web/src/lib/__tests__/resolver-view.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/lib/__tests__/resolver-view.test.ts`:

```ts
describe("deriveResolverView progress payload", () => {
	const progress = {
		startedAt: 1,
		resolvedModel: "claude-sonnet-5",
		turns: 4,
		phase: "analyze",
		activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
	} as const;

	const job = {
		id: "job-1",
		prUrl: "https://github.com/o/r/pull/1",
		status: "running",
		requestedModel: "sonnet",
		runId: null,
		error: null,
		queuePosition: null,
		progress,
	} as const;

	it("passes the snapshot through on a running job", () => {
		expect(
			deriveResolverView({
				resolution: { state: "generating", jobId: "job-1" },
				resolutionError: null,
				job,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress });
	});

	it("keeps the snapshot on a failed job", () => {
		expect(
			deriveResolverView({
				resolution: { state: "generating", jobId: "job-1" },
				resolutionError: null,
				job: { ...job, status: "failed", error: "boom" },
				generationError: null,
			}),
		).toEqual({ tag: "failed", error: "boom", progress });
	});

	it("has no snapshot when there is no job", () => {
		expect(
			deriveResolverView({
				resolution: { state: "needs-generation" },
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress: null });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/web/src/lib/__tests__/resolver-view.test.ts`
Expected: FAIL — returned objects lack `progress`.

- [ ] **Step 3: Update the union and the deriver**

In `packages/web/src/lib/resolver-view.ts`, add the import and change two variants plus three return statements:

```ts
import type { GenerationJob, JobProgress } from "@stagereview/types/generation";
```

```ts
export type ResolverView =
	| { tag: "loading" }
	| { tag: "error"; message: string }
	| { tag: "failed"; error: string; progress: JobProgress | null }
	| { tag: "stale"; runId: string }
	| { tag: "no-clone"; nameWithOwner: string }
	| { tag: "progress"; queuePosition: number | null; progress: JobProgress | null };
```

In `deriveResolverView`, replace the `job !== null` block:

```ts
	if (job !== null) {
		if (job.status === JOB_STATUS.FAILED) {
			return { tag: "failed", error: job.error ?? generationError ?? "", progress: job.progress };
		}
		return {
			tag: "progress",
			queuePosition: job.status === JOB_STATUS.QUEUED ? job.queuePosition : null,
			progress: job.progress,
		};
	}
```

and the two later returns:

```ts
	if (resolution.state === PR_RESOLUTION.FAILED || generationError !== null) {
		return { tag: "failed", error: generationError ?? "", progress: null };
	}
```

```ts
	// ready (pre-navigate), needs-generation, or generating with no job data yet.
	return { tag: "progress", queuePosition: null, progress: null };
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/web/src/lib/__tests__/resolver-view.test.ts`
Expected: FAIL on the pre-existing cases, which still expect two-field objects. Update each of them to include `progress: null` (they all describe job-less or resolution-derived states).

Re-run. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/resolver-view.ts packages/web/src/lib/__tests__/resolver-view.test.ts
git commit -m "feat: carry the progress snapshot through the resolver view"
```

---

## Task 13: Phase rail, activity list, and summary components

**Files:**
- Create: `packages/web/src/components/generation/phase-rail.tsx`
- Create: `packages/web/src/components/generation/activity-list.tsx`
- Create: `packages/web/src/components/generation/progress-summary.tsx`

No tests here: these render markup from props with no branching worth covering, which TESTING.md puts out of scope.

- [ ] **Step 1: Build the rail**

Create `packages/web/src/components/generation/phase-rail.tsx`:

```tsx
import { GENERATION_PHASE_ORDER, type GenerationPhase } from "@stagereview/types/generation";
import { PHASE_LABELS } from "@/lib/generation-labels";
import { cn } from "@/lib/utils";

/**
 * The four-step rail. The current step is marked with aria-current and a text
 * label, never colour alone. On narrow layouts the labels wrap rather than
 * forcing the card wider.
 */
export function PhaseRail({ phase }: { phase: GenerationPhase }) {
	const currentIndex = GENERATION_PHASE_ORDER.indexOf(phase);
	return (
		<ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
			{GENERATION_PHASE_ORDER.map((step, index) => {
				const isCurrent = index === currentIndex;
				const isDone = index < currentIndex;
				return (
					<li
						key={step}
						aria-current={isCurrent ? "step" : undefined}
						className="flex items-center gap-2"
					>
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								isDone && "bg-muted-foreground",
								isCurrent && "bg-foreground",
								!isDone && !isCurrent && "bg-border",
							)}
						/>
						<span
							className={cn(
								"text-xs",
								isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
							)}
						>
							{PHASE_LABELS[step]}
						</span>
						{index < GENERATION_PHASE_ORDER.length - 1 && (
							<span aria-hidden className="hidden h-px w-4 bg-border sm:block" />
						)}
					</li>
				);
			})}
		</ol>
	);
}
```

- [ ] **Step 2: Build the activity list**

Create `packages/web/src/components/generation/activity-list.tsx`:

```tsx
import { ACTIVITY_STATE, type ActivityEntry } from "@stagereview/types/generation";
import { Check, Loader2, X } from "lucide-react";
import { ACTIVITY_STATE_LABELS } from "@/lib/generation-labels";

function StateIcon({ state }: { state: ActivityEntry["state"] }) {
	const label = ACTIVITY_STATE_LABELS[state];
	if (state === ACTIVITY_STATE.RUNNING) {
		return <Loader2 aria-label={label} className="size-3 shrink-0 animate-spin" />;
	}
	if (state === ACTIVITY_STATE.FAILED) {
		return <X aria-label={label} className="size-3 shrink-0 text-destructive" />;
	}
	return <Check aria-label={label} className="size-3 shrink-0 text-muted-foreground" />;
}

/**
 * The agent's recent tool calls, oldest first. `flex-col-reverse` over a
 * reversed list keeps the newest entry pinned to the bottom edge without
 * scripted scrolling, and min-w-0 + truncate stop a long path from widening
 * the card.
 */
export function ActivityList({ activity }: { activity: readonly ActivityEntry[] }) {
	if (activity.length === 0) return null;
	return (
		<ul className="max-h-40 space-y-1 overflow-y-auto">
			{activity.map((entry, index) => (
				<li
					// Entries are an append-only ring with no stable id; position plus
					// identity is stable enough for a list that only ever appends.
					key={`${index}-${entry.tool}-${entry.target}`}
					className="flex items-center gap-2 text-xs"
				>
					<StateIcon state={entry.state} />
					<span className="shrink-0 font-medium text-muted-foreground">{entry.tool}</span>
					<span className="min-w-0 truncate font-mono text-muted-foreground">{entry.target}</span>
				</li>
			))}
		</ul>
	);
}
```

- [ ] **Step 3: Build the summary line**

Create `packages/web/src/components/generation/progress-summary.tsx`:

```tsx
import type { GenerationJob } from "@stagereview/types/generation";
import { formatDurationSeconds } from "@/lib/format";
import { useElapsedSeconds } from "@/lib/use-elapsed";

/**
 * `sonnet · 1m 42s · 14 turns`. Falls back to the requested model until the
 * agent's init event reports what the CLI actually resolved.
 *
 * Deliberately not a live region: a polite announcement every second would
 * make the page unusable with a screen reader.
 */
export function ProgressSummary({ job }: { job: GenerationJob }) {
	const elapsed = useElapsedSeconds(job.progress?.startedAt ?? null);
	const parts = [job.progress?.resolvedModel ?? job.requestedModel];
	const duration = elapsed === null ? null : formatDurationSeconds(elapsed);
	if (duration !== null) parts.push(duration);
	const turns = job.progress?.turns ?? 0;
	if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	return <p className="text-muted-foreground text-xs">{parts.join(" · ")}</p>;
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/generation
git commit -m "feat: add phase rail, activity list, and progress summary"
```

---

## Task 14: Rebuild the resolver's progress and failure cards

**Files:**
- Modify: `packages/web/src/app/pr.$owner.$repo.$number.tsx:54-134`
- Modify: `packages/web/src/lib/use-pr-resolution.ts:20`

- [ ] **Step 1: Speed up the poll**

In `packages/web/src/lib/use-pr-resolution.ts`, change line 20:

```ts
/** A second is enough to make the activity feed feel live; the job poll stops entirely once terminal. */
const JOB_POLL_INTERVAL_MS = 1_000;
```

- [ ] **Step 2: Pass the job into the cards**

In `packages/web/src/app/pr.$owner.$repo.$number.tsx`, update the two switch arms in `ResolverBody`:

```tsx
			case "failed":
				return <FailedCard error={view.error} progress={view.progress} job={job} onRetry={generate} />;
```

```tsx
			case "progress":
				return (
					<ProgressCard
						prLabel={prLabel}
						queuePosition={view.queuePosition}
						progress={view.progress}
						job={job}
					/>
				);
```

- [ ] **Step 3: Replace `ProgressCard`**

Replace the existing `ProgressCard` function with:

```tsx
function ProgressCard({
	prLabel,
	queuePosition,
	progress,
	job,
}: {
	prLabel: string;
	queuePosition: number | null;
	progress: JobProgress | null;
	job: GenerationJob | null;
}) {
	// Queued jobs have no process yet, so there is nothing to show but the
	// place in line — the pre-existing presentation, unchanged.
	if (progress === null || job === null) {
		return (
			<div className="flex items-center gap-3 rounded-lg border p-4">
				<Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
				<div className="min-w-0 space-y-1">
					<p className="truncate font-medium text-sm">{prLabel}</p>
					<p className="text-muted-foreground text-xs">
						{queuePosition !== null ? `Queued — ${queuePosition} ahead` : "Chaptering…"}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-3 rounded-lg border p-4">
			<div className="flex items-center gap-3">
				<Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
				<div className="min-w-0 flex-1 space-y-0.5">
					<p className="truncate font-medium text-sm">{prLabel}</p>
					<ProgressSummary job={job} />
				</div>
			</div>
			<PhaseRail phase={progress.phase} />
			<ActivityList activity={progress.activity} />
		</div>
	);
}
```

- [ ] **Step 4: Replace `FailedCard`**

```tsx
function FailedCard({
	error,
	progress,
	job,
	onRetry,
}: {
	error: string;
	progress: JobProgress | null;
	job: GenerationJob | null;
	onRetry: () => void;
}) {
	return (
		<div className="space-y-3 rounded-lg border p-4">
			<div className="space-y-1">
				<p className="text-destructive text-sm">{error}</p>
				{progress !== null && (
					<p className="text-muted-foreground text-xs">
						Failed during: {PHASE_LABELS[progress.phase]}
					</p>
				)}
				{job !== null && progress !== null && <ProgressSummary job={job} />}
			</div>
			{progress !== null && progress.activity.length > 0 && (
				<details className="space-y-2">
					<summary className="cursor-pointer text-muted-foreground text-xs">Last steps</summary>
					<div className="pt-2">
						<ActivityList activity={progress.activity} />
					</div>
				</details>
			)}
			<Button onClick={onRetry}>
				<RefreshCw className="size-3.5" />
				Retry
			</Button>
		</div>
	);
}
```

- [ ] **Step 5: Fix the imports**

Add to the top of the file:

```tsx
import type { GenerationJob, JobProgress } from "@stagereview/types/generation";
import { ActivityList } from "@/components/generation/activity-list";
import { PhaseRail } from "@/components/generation/phase-rail";
import { ProgressSummary } from "@/components/generation/progress-summary";
import { PHASE_LABELS } from "@/lib/generation-labels";
```

- [ ] **Step 6: Typecheck, lint, test**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app/pr.\$owner.\$repo.\$number.tsx packages/web/src/lib/use-pr-resolution.ts
git commit -m "feat: show phase and activity on the resolver page"
```

---

## Task 15: Dashboard row badges and terminal invalidation

`GET /api/generate` drops a job the moment it finishes, and `usePullRequests` has `staleTime: 60_000` with no `refetchInterval` — becoming stale does not make it refetch. Without an explicit invalidation, a dashboard tab watching a job loses the phase badge and never gains "Chaptered".

**Files:**
- Create: `packages/web/src/lib/use-active-jobs.ts`
- Create: `packages/web/src/lib/__tests__/use-active-jobs.test.tsx`
- Modify: `packages/web/src/components/dashboard/pull-request-list.tsx`
- Modify: `packages/web/src/app/index.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/__tests__/use-active-jobs.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PULL_REQUESTS_QUERY_ROOT } from "../use-pull-requests";
import { useActiveJobs } from "../use-active-jobs";

function job(id: string) {
	return {
		id,
		prUrl: `https://github.com/o/r/pull/${id}`,
		status: "running",
		requestedModel: "sonnet",
		runId: null,
		error: null,
		queuePosition: null,
		progress: null,
	};
}

describe("useActiveJobs", () => {
	let client: QueryClient;

	function wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}

	beforeEach(() => {
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("invalidates the pull-request list when a job leaves the active set", async () => {
		const responses = [{ jobs: [job("a")] }, { jobs: [] }];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => responses.shift() ?? { jobs: [] },
			})),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const { result } = renderHook(() => useActiveJobs(), { wrapper });
		await waitFor(() => expect(result.current).toHaveLength(1));

		await client.refetchQueries({ queryKey: ["active-generation-jobs"] });
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({ queryKey: [PULL_REQUESTS_QUERY_ROOT] }),
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/web/src/lib/__tests__/use-active-jobs.test.tsx`
Expected: FAIL — cannot resolve `../use-active-jobs`.

- [ ] **Step 3: Implement the hook**

Create `packages/web/src/lib/use-active-jobs.ts`:

```ts
import {
	ActiveGenerationJobsSchema,
	type ActiveGenerationJobs,
	type GenerationJob,
} from "@stagereview/types/generation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { PULL_REQUESTS_QUERY_ROOT } from "./use-pull-requests";
import { RUNS_QUERY_KEY } from "./use-runs";
import { jsonFetch } from "./use-view-state";

const ACTIVE_JOBS_QUERY_KEY = ["active-generation-jobs"] as const;
const POLL_INTERVAL_MS = 3_000;

/**
 * Every generation job currently queued or running, for badging dashboard rows.
 *
 * The endpoint returns only non-terminal jobs, so a finished job simply
 * disappears. usePullRequests has a stale time but no refetch interval —
 * staleness alone never triggers a fetch — so a departure has to invalidate the
 * list explicitly, or a row would lose its phase badge and never gain
 * "Chaptered".
 */
export function useActiveJobs(): GenerationJob[] {
	const queryClient = useQueryClient();
	const previousIds = useRef<ReadonlySet<string>>(new Set());

	const { data } = useQuery<ActiveGenerationJobs>({
		queryKey: ACTIVE_JOBS_QUERY_KEY,
		queryFn: async () =>
			ActiveGenerationJobsSchema.parse(await jsonFetch<unknown>("/api/generate")),
		refetchInterval: POLL_INTERVAL_MS,
	});

	const jobs = data?.jobs;
	useEffect(() => {
		if (jobs === undefined) return;
		const current = new Set(jobs.map((activeJob) => activeJob.id));
		const departed = [...previousIds.current].some((id) => !current.has(id));
		previousIds.current = current;
		if (!departed) return;
		void queryClient.invalidateQueries({ queryKey: [PULL_REQUESTS_QUERY_ROOT] });
		void queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY });
	}, [jobs, queryClient]);

	return jobs ?? [];
}

/** The active job for a PR URL, matched case-insensitively as the server does. */
export function findJobForPr(jobs: readonly GenerationJob[], prUrl: string): GenerationJob | null {
	const wanted = prUrl.toLowerCase();
	return jobs.find((activeJob) => activeJob.prUrl.toLowerCase() === wanted) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/web/src/lib/__tests__/use-active-jobs.test.tsx`
Expected: PASS.

If `@testing-library/react` is not already a dev dependency, add it first:

```bash
pnpm add -D -w @testing-library/react
```

- [ ] **Step 5: Badge the rows**

In `packages/web/src/components/dashboard/pull-request-list.tsx`, add to the imports:

```tsx
import type { GenerationJob } from "@stagereview/types/generation";
import { Loader2 } from "lucide-react";
import { findJobForPr } from "@/lib/use-active-jobs";
import { PHASE_BADGES } from "@/lib/generation-labels";
```

Add `activeJobs` to `PullRequestListProps`:

```tsx
	/** Jobs in flight, for badging rows that are mid-generation. */
	activeJobs: readonly GenerationJob[];
```

Destructure it in `PullRequestList` and pass the match down:

```tsx
			{rows.map((pr) => (
				<PullRequestRow key={pr.url} pullRequest={pr} job={findJobForPr(activeJobs, pr.url)} />
			))}
```

Replace the badge line inside `PullRequestRow` (keep the rest of the row as it is), and take the new prop:

```tsx
function PullRequestRow({
	pullRequest,
	job,
}: {
	pullRequest: DashboardPullRequest;
	job: GenerationJob | null;
}) {
```

```tsx
					{pullRequest.isDraft && <Badge variant="outline">Draft</Badge>}
					{!pullRequest.cloned && <Badge variant="outline">Not cloned</Badge>}
					{job !== null ? (
						<Badge variant="outline" className="gap-1">
							<Loader2 className="size-3 animate-spin" />
							{job.progress === null ? "Queued" : PHASE_BADGES[job.progress.phase]}
						</Badge>
					) : (
						pullRequest.runId !== null && <Badge variant="outline">Chaptered</Badge>
					)}
```

- [ ] **Step 6: Feed the dashboard**

In `packages/web/src/app/index.tsx`, add the import and the hook call, then pass it to all three lists:

```tsx
import { useActiveJobs } from "@/lib/use-active-jobs";
```

```tsx
	const activeJobs = useActiveJobs();
```

Add `activeJobs={activeJobs}` to each of the three `<PullRequestList …>` elements.

- [ ] **Step 7: Verify everything**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS across all three.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src
git commit -m "feat: badge dashboard rows with live generation phase"
```

---

## Task 16: End-to-end verification

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: SPA build succeeds and `packages/cli/dist` + `packages/cli/web-dist` are written.

- [ ] **Step 2: Run the daemon against a real PR**

```bash
node packages/cli/dist/index.js start
```

Open the dashboard, pick a PR with a known local clone, and confirm:

- the row shows a spinning badge that moves Prep → Analyze → Write → Import
- the resolver page shows the rail, `model · elapsed · turns`, and tool calls appearing live
- the terminal running `start` prints `[stage:generate] …` phase transitions
- on success the page navigates to the run and the row flips to "Chaptered" without a manual refresh

- [ ] **Step 3: Confirm the failure path**

Temporarily rename the `claude` binary on your PATH, retry generation, and confirm the resolver shows a failure with the phase it died in rather than a blank card, and that the daemon does not crash.

- [ ] **Step 4: Final gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

---

## Notes for the implementer

**The repo is intentionally red between Task 5 and Task 10.** Task 5 widens the shared wire type, which breaks the CLI until Task 9 supplies the new fields and Task 10 serializes them. Don't try to patch the type errors early — the later tasks resolve them by construction.

**Don't reorder Tasks 2-4.** `describe-tool-use.ts` and `phase-tracker.ts` both import `bash-commands.ts`, and `stream-events.ts` imports `sanitizeText` from `describe-tool-use.ts`.

**Route order matters in Task 10.** `/api/generate` must be registered before `/api/generate/:jobId`, or the parameter pattern swallows the list request.
