import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

export const JOB_STATUS = {
	QUEUED: "queued",
	RUNNING: "running",
	SUCCEEDED: "succeeded",
	FAILED: "failed",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

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

export interface Job extends JobRequest {
	id: string;
	status: JobStatus;
	runId: string | null;
	error: string | null;
}

/** Returns the new runId on success. */
export type JobRunner = (job: JobRequest) => Promise<string>;

/**
 * Runs generation jobs one at a time. Each job spawns a headless agent that is
 * expensive and touches a git worktree, so overlapping runs are never safe —
 * further requests queue behind the one in flight.
 */
export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private readonly queue: string[] = [];
	private running = false;
	private idle: Promise<void> = Promise.resolve();
	private resolveIdle: () => void = () => {};

	constructor(private readonly runner: JobRunner) {}

	enqueue(request: JobRequest): string {
		const id = randomUUID();
		this.jobs.set(id, { ...request, id, status: JOB_STATUS.QUEUED, runId: null, error: null });
		this.queue.push(id);
		if (!this.running) {
			this.idle = new Promise((resolve) => {
				this.resolveIdle = resolve;
			});
			void this.drain();
		}
		return id;
	}

	get(id: string): Job | null {
		return this.jobs.get(id) ?? null;
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	/** Resolves when the queue is empty. For tests and graceful shutdown. */
	settled(): Promise<void> {
		return this.running ? this.idle : Promise.resolve();
	}

	private async drain(): Promise<void> {
		this.running = true;
		let id = this.queue.shift();
		while (id !== undefined) {
			const job = this.jobs.get(id);
			if (job) {
				job.status = JOB_STATUS.RUNNING;
				try {
					job.runId = await this.runner(job);
					job.status = JOB_STATUS.SUCCEEDED;
				} catch (err) {
					job.status = JOB_STATUS.FAILED;
					job.error = err instanceof Error ? err.message : String(err);
				}
			}
			id = this.queue.shift();
		}
		this.running = false;
		this.resolveIdle();
	}
}

const AGENT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

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
			["-p", prompt, "--model", job.model],
			{
				cwd: job.repoRoot,
				encoding: "utf8",
				maxBuffer: AGENT_OUTPUT_LIMIT_BYTES,
				timeout: AGENT_TIMEOUT_MS,
			},
			(err, stdout) => {
				if (err) {
					reject(new Error(err.message));
					return;
				}
				const lines = stdout.trim().split("\n");
				const runId = lines[lines.length - 1]?.trim();
				if (!runId || !UUID_PATTERN.test(runId)) {
					reject(new Error(`Agent did not return a runId. Last output: ${runId || "(empty)"}`));
					return;
				}
				resolve(runId);
			},
		);
	});
}
