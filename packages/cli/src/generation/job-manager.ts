import { randomUUID } from "node:crypto";
import {
	type GenerationJob,
	GenerationJobSchema,
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
	STDOUT_DRAIN_MS,
	spawnClaude,
} from "./agent-session.js";

// Re-exported so existing importers (and the job-manager tests) keep resolving
// it here; the implementation lives in run-id.ts to keep agent-session.ts and
// job-manager.ts free of an import cycle.
export { parseRunnerOutput } from "./run-id.js";

export interface JobRequest {
	prUrl: string;
	repoRoot: string;
	/** The model the caller asked for — may differ from what the agent actually runs. */
	requestedModel: GenerationModel;
}

export interface Job extends JobRequest, GenerationJob {}

/** Returns the new runId on success. `onProgress` may be called any number of times before then. */
export type JobRunner = (
	job: JobRequest,
	onProgress: (progress: JobProgress) => void,
) => Promise<string>;

/**
 * The browser-facing view of a job. `Job` is a supertype of `GenerationJob` — it
 * also carries `repoRoot`, an absolute path on the user's machine — so serializing
 * a `Job` directly would leak it. Parsing strips every key the wire type does not
 * declare, which keeps that true as `Job` grows.
 */
export function toWireJob(job: Job): GenerationJob {
	return GenerationJobSchema.parse(job);
}

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

	/**
	 * Every job that has not reached a terminal status — what the dashboard badges.
	 * Insertion-ordered, oldest first.
	 */
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
		drainMs: STDOUT_DRAIN_MS,
	}).run();
}
