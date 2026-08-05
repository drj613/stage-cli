import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import readline from "node:readline";
import type { JobProgress } from "@stagereview/types/generation";
import { sanitizeText } from "./describe-tool-use.js";
import type { JobRequest } from "./job-manager.js";
import { parseRunnerOutput as parseRunId } from "./run-id.js";
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
