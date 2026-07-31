import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type GenerationJob, isTerminalJobStatus, JOB_STATUS } from "@stagereview/types/generation";
import { z } from "zod";

export const GENERATION_MODEL = {
	SONNET: "sonnet",
	OPUS: "opus",
	HAIKU: "haiku",
} as const;
export type GenerationModel = (typeof GENERATION_MODEL)[keyof typeof GENERATION_MODEL];

export interface JobRequest {
	prUrl: string;
	repoRoot: string;
	model: GenerationModel;
}

export interface Job extends JobRequest, GenerationJob {}

/** Returns the new runId on success. */
export type JobRunner = (job: JobRequest) => Promise<string>;

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
		const job: Job = {
			...request,
			id: randomUUID(),
			status: JOB_STATUS.QUEUED,
			runId: null,
			error: null,
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
				return { ...job };
			}
		}
		return null;
	}

	/** A snapshot of the job — callers can't mutate the queue's state through it. */
	get(id: string): Job | null {
		const job = this.jobs.get(id);
		return job ? { ...job } : null;
	}

	/** Resolves when the queue is empty. For tests and graceful shutdown. */
	settled(): Promise<void> {
		return this.running ? this.idle : Promise.resolve();
	}

	private async drain(): Promise<void> {
		this.running = true;
		let job = this.queue.shift();
		while (job !== undefined) {
			job.status = JOB_STATUS.RUNNING;
			try {
				job.runId = await this.runner(job);
				job.status = JOB_STATUS.SUCCEEDED;
			} catch (err) {
				job.status = JOB_STATUS.FAILED;
				job.error = err instanceof Error ? err.message : String(err);
			}
			job = this.queue.shift();
		}
		this.running = false;
		this.resolveIdle();
	}
}

const AGENT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
/** How much stderr to quote back when the agent fails — enough to be diagnostic, not a wall of log. */
const STDERR_TAIL_LINES = 5;
/** Nobody is at the keyboard to answer tool prompts, and this daemon only ever runs on the user's own machine against their own clones. */
const PERMISSION_MODE = "bypassPermissions";

const runIdSchema = z.string().uuid();

/** Last ~5 lines of stderr, formatted for appending to an error message. */
function stderrTail(stderr: string): string {
	const lines = stderr.trim().split("\n").slice(-STDERR_TAIL_LINES);
	return lines.length > 0 && lines[0] !== "" ? `\n${lines.join("\n")}` : "";
}

/**
 * The runId the agent was told to print as its last line. Throws when the agent
 * ended on anything else — a missing or malformed runId means the run didn't
 * land in the database, so failing loudly beats surfacing a bogus link.
 */
export function parseRunnerOutput(stdout: string): string {
	const lines = stdout.trim().split("\n");
	const lastLine = lines[lines.length - 1]?.trim() ?? "";
	const parsed = runIdSchema.safeParse(lastLine);
	if (!parsed.success) {
		throw new Error(`Agent did not return a runId. Last output: ${lastLine || "(empty)"}`);
	}
	return parsed.data;
}

/**
 * The real runner: headless claude with the stage-chapters skill, told to
 * finish with `stagereview import` (never `show` — the daemon already serves).
 * Runs in the repo's clone so prep/import resolve the right git state.
 */
export function claudeRunner(job: JobRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		const prompt = [
			`/stage-chapters --pr ${job.prUrl}`,
			"IMPORTANT: this is a headless run for the Stage dashboard.",
			"In the final step, run `stagereview import` (same arguments as `show`) instead of `stagereview show`,",
			"and print ONLY the runId it outputs as your last line.",
		].join("\n");
		execFile(
			"claude",
			["-p", prompt, "--model", job.model, "--permission-mode", PERMISSION_MODE],
			{
				cwd: job.repoRoot,
				encoding: "utf8",
				maxBuffer: AGENT_OUTPUT_LIMIT_BYTES,
				timeout: AGENT_TIMEOUT_MS,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(`${err.message}${stderrTail(stderr)}`));
					return;
				}
				try {
					resolve(parseRunnerOutput(stdout));
				} catch (parseErr) {
					reject(parseErr);
				}
			},
		);
	});
}
