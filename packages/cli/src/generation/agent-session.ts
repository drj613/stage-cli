import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import readline from "node:readline";
import type { JobProgress } from "@stagereview/types/generation";
import { redactPaths, sanitizeText } from "./describe-tool-use.js";
import type { JobRequest } from "./job-manager.js";
import { parseRunnerOutput as parseRunId } from "./run-id.js";
import { errorResultMessage, isSuccessResult } from "./stream-events.js";
import { StreamReducer } from "./stream-reducer.js";

export const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
/** How long a SIGTERM gets before we escalate. */
export const KILL_GRACE_MS = 10 * 1000;
/** How long a pre-spawn error waits for a `close` that may never come. */
export const ERROR_GRACE_MS = 1_000;
/**
 * How long stdout gets to finish after the child exits. A grandchild that
 * inherited the pipe keeps stdout open after its parent is reaped, so `close`
 * may never arrive at all; without this bound the promise — and the whole job
 * queue behind it — would wait forever.
 */
export const STDOUT_DRAIN_MS = 5_000;
/** Nobody is at the keyboard to answer tool prompts, and this daemon only ever runs on the user's own machine against their own clones. */
const PERMISSION_MODE = "bypassPermissions";
/** Lines of stderr kept for the tail appended to a failure message. */
export const STDERR_TAIL_LINES = 5;
/** Lines teed to the terminal before we go quiet, so a chatty agent can't flood it. */
export const STDERR_TEE_LINES = 200;
/** Characters kept per stderr line, both in the tee and in the tail. */
export const STDERR_LINE_LIMIT = 200;
/** Slack for what sanitizing strips, so trimming first never loses visible characters. */
const STDERR_RAW_LIMIT = STDERR_LINE_LIMIT * 4;

/** The slice of ChildProcess this class uses — narrowed so tests can fake it. */
export type SpawnedChild = Pick<ChildProcess, "kill"> &
	EventEmitter & {
		stdout: NodeJS.ReadableStream | null;
		stderr: NodeJS.ReadableStream | null;
	};

export interface AgentSessionOptions {
	readonly job: JobRequest;
	/**
	 * Called with a fresh snapshot on every stream line. It MUST NOT throw: it is
	 * invoked from a stream listener, so an exception escapes as an
	 * `uncaughtException` and leaves this session's promise pending forever, with
	 * the job queue stuck behind it. Store the snapshot; do nothing that can fail.
	 */
	readonly onProgress: (progress: JobProgress) => void;
	/** Must return a positive-integer epoch-ms timestamp — see the constructor. */
	readonly now: () => number;
	readonly spawnChild: (job: JobRequest) => SpawnedChild;
	readonly timeoutMs: number;
	readonly killGraceMs: number;
	readonly errorGraceMs: number;
	readonly drainMs: number;
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
 * `run()` settles exactly once. It waits for the child to be gone before doing
 * so, which is a queue-safety requirement rather than tidiness: JobManager's
 * drain awaits this promise, so settling while the child is still alive would
 * start the next agent against a worktree the previous one may still be writing.
 *
 * Three events can settle it: `close` (the normal path, and the only one that
 * guarantees stdout was fully read), `exit` plus a bounded drain window when
 * stdout is held open by something the agent spawned, and — before the process
 * ever existed — a spawn `error`.
 */
export class AgentSession {
	private readonly reducer: StreamReducer;
	private readonly options: AgentSessionOptions;
	private readonly stderrTail: string[] = [];
	private stderrTeed = 0;
	private started = false;
	private settled = false;
	private spawned = false;
	private timedOut = false;
	private spawnError: Error | null = null;
	private timeoutTimer: NodeJS.Timeout | null = null;
	private killTimer: NodeJS.Timeout | null = null;
	private errorTimer: NodeJS.Timeout | null = null;
	private drainTimer: NodeJS.Timeout | null = null;

	/**
	 * `now()` is a system boundary: its value becomes `JobProgress.startedAt`, and
	 * anything but a positive integer produces snapshots the SPA's schema rejects,
	 * which parks the dashboard's poll in a permanent error state. Fail here, where
	 * the cause is obvious, rather than there.
	 */
	constructor(options: AgentSessionOptions) {
		const startedAt = options.now();
		if (!Number.isInteger(startedAt) || startedAt <= 0) {
			throw new Error(`AgentSession needs a positive epoch-ms clock, got ${startedAt}.`);
		}
		this.options = options;
		this.reducer = new StreamReducer(options.job.repoRoot, startedAt);
	}

	private get tag(): string {
		return `[stage:generate] ${this.options.job.prUrl}`;
	}

	/** One session, one process. A second call could never settle. */
	run(): Promise<string> {
		if (this.started) throw new Error("AgentSession.run() was already called.");
		this.started = true;
		return new Promise<string>((resolve, reject) => {
			const child = this.options.spawnChild(this.options.job);

			const settle = (outcome: () => void) => {
				if (this.settled) return;
				this.settled = true;
				this.clearTimers();
				outcome();
			};

			/** Settles on how the process ended, whatever told us it had. */
			const finish = (code: number | null, signal: NodeJS.Signals | null) => {
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
			};

			child.on("spawn", () => {
				this.spawned = true;
				// Without this first push, progress stays null until the init event
				// lands seconds later and a running job looks queued.
				this.report();
			});

			child.on("error", (err: Error) => {
				if (this.settled) return;
				this.spawnError = err;
				if (this.spawned) {
					// The process exists and may still hold the worktree. Do not release
					// the queue — escalate, and stay pending if it never closes.
					console.error(`${this.tag} process error after spawn: ${err.message}`);
					this.signal(child, "SIGKILL");
					return;
				}
				// Nothing was ever created, so nothing can be holding the worktree.
				this.errorTimer = setTimeout(() => {
					settle(() => reject(err));
				}, this.options.errorGraceMs);
			});

			// `close` means the process is gone AND its stdio is drained, so it is the
			// only event we can settle on without risking a lost final line.
			child.on("close", finish);

			// A grandchild that inherited stdout keeps the pipe open after its parent
			// is reaped, so `close` may never come. Give stdout a bounded window to
			// finish, then settle on the exit status anyway.
			child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
				if (this.settled) return;
				this.drainTimer = setTimeout(() => {
					console.error(`${this.tag} stdout never closed after exit — settling on the exit status`);
					finish(code, signal);
				}, this.options.drainMs);
			});

			if (child.stdout) {
				readline
					.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
					.on("line", (line) => {
						this.reducer.consumeLine(line);
						this.report();
					});
			}
			if (child.stderr) {
				readline
					.createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY })
					.on("line", (line) => this.recordStderr(line));
			}

			this.timeoutTimer = setTimeout(() => {
				if (this.settled) return;
				this.timedOut = true;
				console.error(`${this.tag} timed out — sending SIGTERM`);
				if (!this.signal(child, "SIGTERM")) return;
				this.killTimer = setTimeout(() => {
					if (this.settled) return;
					console.error(`${this.tag} still running — sending SIGKILL`);
					this.signal(child, "SIGKILL");
				}, this.options.killGraceMs);
			}, this.options.timeoutMs);
		});
	}

	/**
	 * Hands the current snapshot to the caller, unless this run has settled. The
	 * bounded-drain path settles while stdout — and the readline interface reading
	 * it — are still open, so lines keep arriving afterwards; forwarding them would
	 * keep a finished job's activity changing in the dashboard.
	 */
	private report(): void {
		if (this.settled) return;
		this.options.onProgress(this.reducer.snapshot());
	}

	/**
	 * Sends a signal, reporting whether it could land. `kill` returns false when
	 * the process has already been reaped — escalating to a pid that no longer
	 * exists achieves nothing, so the caller stops and lets the drain window
	 * settle the run.
	 */
	private signal(child: SpawnedChild, signal: NodeJS.Signals): boolean {
		if (child.kill(signal)) return true;
		console.error(`${this.tag} already exited — waiting for stdout to drain`);
		return false;
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

	/**
	 * Trims before sanitizing, exactly as `stream-events.ts` does and for the same
	 * reason: sanitizing segments the string into graphemes, so on a multi-megabyte
	 * line — which readline will happily buffer — it blocks the event loop for the
	 * best part of a second to discard all but 200 characters.
	 *
	 * The two sinks diverge, and only on paths. The tail becomes `job.error`, which
	 * crosses into a browser, so its absolute paths are rewritten the way a tool
	 * target's are — redacting after the trim keeps the walk bounded, and before the
	 * cap so a shortened path spends its saving on message text. The tee goes to the
	 * daemon's own terminal, where the operator owns the paths already and needs them
	 * whole: an out-of-clone failure reduced to a basename is undiagnosable, so this
	 * is the full-fidelity copy. Sanitizing is not part of that split — an escape
	 * sequence reaching a terminal is the hazard `sanitizeText` exists for.
	 */
	private recordStderr(line: string): void {
		const clean = sanitizeText(line.slice(0, STDERR_RAW_LIMIT));
		if (clean === "") return;
		const teed = clean.slice(0, STDERR_LINE_LIMIT);
		const redacted = redactPaths(clean, this.options.job.repoRoot).slice(0, STDERR_LINE_LIMIT);
		this.stderrTail.push(redacted);
		if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
		if (this.stderrTeed < STDERR_TEE_LINES) {
			this.stderrTeed += 1;
			console.error(`${this.tag} ${teed}`);
		}
	}

	private clearTimers(): void {
		for (const timer of [this.timeoutTimer, this.killTimer, this.errorTimer, this.drainTimer]) {
			if (timer !== null) clearTimeout(timer);
		}
		this.timeoutTimer = null;
		this.killTimer = null;
		this.errorTimer = null;
		this.drainTimer = null;
	}
}
