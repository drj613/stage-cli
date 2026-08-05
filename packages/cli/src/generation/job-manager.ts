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

/**
 * How many PRs keep a finished job. A terminal job is retained for two reasons:
 * a poll that lands just after a run finishes must still find it, and
 * `latestJobFor` needs it to report a failure the dashboard can render. Both
 * only ever want the newest job for a PR, and this daemon runs for weeks, so
 * older jobs for the same PR go as soon as they are superseded and the number of
 * distinct PRs is capped. Fifty is well past what a session browses, and the
 * whole retained set is a few hundred kilobytes at worst.
 */
export const MAX_RETAINED_PRS = 50;

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

	/**
	 * `now` stamps the end of every run, so it must be the same clock the runner
	 * reads for `startedAt` — two clocks can hand the UI a duration neither of
	 * them would recognize.
	 */
	constructor(
		private readonly runner: JobRunner,
		private readonly now: () => number = Date.now,
	) {}

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
	 * Insertion-ordered, oldest first, and already converted for the wire: handing
	 * out `Job` here would let a list route ship `repoRoot` without a type error,
	 * since `satisfies` does not check excess properties on an array.
	 */
	activeJobs(): GenerationJob[] {
		const active: GenerationJob[] = [];
		for (const job of this.jobs.values()) {
			if (!isTerminalJobStatus(job.status)) active.push(toWireJob(this.snapshot(job)));
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

	/** A snapshot of the job — see {@link JobManager.snapshot} for how deep it copies. */
	get(id: string): Job | null {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job) : null;
	}

	/** 1-based place in line, or null when running or terminal. drain() shifts the running job off the queue, so indexOf is exact. */
	private positionOf(job: Job): number | null {
		const idx = this.queue.indexOf(job);
		return idx >= 0 ? idx + 1 : null;
	}

	/**
	 * A copy deep enough that nothing a caller holds is shared with the queue:
	 * every field of the job, and every field of its progress down to the activity
	 * entries. That depth is exact, not defensive — the same hazard
	 * `StreamReducer.snapshot` documents. A shallow copy would let a caller write
	 * a value `GenerationJobSchema` rejects, after which every poll for that job
	 * fails; add a nested field to `ActivityEntry` and this stops being isolation.
	 */
	private snapshot(job: Job): Job {
		const { progress } = job;
		return {
			...job,
			queuePosition: this.positionOf(job),
			progress:
				progress === null
					? null
					: { ...progress, activity: progress.activity.map((entry) => ({ ...entry })) },
		};
	}

	/**
	 * Resolves once every enqueued job has settled. Used by tests; a runner that
	 * never settles leaves this pending, exactly as it leaves the queue stalled.
	 */
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
				// The only signal a headless run failed: the dashboard may not be open,
				// and nothing else writes this. The PR identifies the job; the clone
				// path is deliberately left out.
				console.error(`[stage:generate] ${current.prUrl} failed: ${current.error}`);
			}
			this.recordEnd(current, this.now());
			this.evictTerminal();
			job = this.queue.shift();
		}
		this.running = false;
		this.resolveIdle();
	}

	/**
	 * Freezes the run's duration at the moment its runner settled, whichever way
	 * it settled. Written here, once, because this is the only place that knows a
	 * job is over: the session stops reporting progress the instant it settles, so
	 * nothing can overwrite the stamp, and a job whose process never reported has
	 * no snapshot to stamp.
	 */
	private recordEnd(job: Job, endedAt: number): void {
		if (job.progress === null) return;
		job.progress = { ...job.progress, endedAt };
	}

	/**
	 * Drops finished jobs the dashboard can no longer use: any superseded by a newer
	 * job for the same PR, then the oldest PRs past {@link MAX_RETAINED_PRS}.
	 * Non-terminal jobs are never touched. Deleting an entry already visited is safe
	 * during Map iteration.
	 */
	private evictTerminal(): void {
		const newestByPr = new Map<string, Job>();
		for (const job of this.jobs.values()) {
			if (!isTerminalJobStatus(job.status)) continue;
			const key = job.prUrl.toLowerCase();
			const superseded = newestByPr.get(key);
			if (superseded !== undefined) this.jobs.delete(superseded.id);
			// Re-inserting moves the PR to the end, so iteration order is oldest first.
			newestByPr.delete(key);
			newestByPr.set(key, job);
		}
		let excess = newestByPr.size - MAX_RETAINED_PRS;
		for (const job of newestByPr.values()) {
			if (excess <= 0) return;
			this.jobs.delete(job.id);
			excess -= 1;
		}
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
