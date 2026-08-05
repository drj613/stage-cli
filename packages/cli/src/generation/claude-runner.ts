import {
	ACTIVITY_STATE,
	type ActivityState,
	GENERATION_PHASE,
	type JobProgress,
} from "@stagereview/types/generation";
import { buildSyntheticChaptersFile } from "../build-synthetic-chapters-file.js";
import { getDb, type StageDb } from "../db/client.js";
import { readRepoContext } from "../git.js";
import { type ResolvedFilteredDiff, resolveFilteredDiff } from "../resolve-diff.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import type { DiffScopeOptions } from "../scope.js";
import {
	AGENT_TIMEOUT_MS,
	AgentSession,
	ERROR_GRACE_MS,
	KILL_GRACE_MS,
	type SpawnedChild,
	STDOUT_DRAIN_MS,
	spawnClaude,
} from "./agent-session.js";
import type { JobRequest } from "./job-manager.js";
import { shouldGenerateChapters } from "./should-generate-chapters.js";

/** What the synthetic path shows in the dashboard's activity list. */
const SKIPPED_ACTIVITY = {
	TOOL: "stagereview import",
	TARGET: "small diff — chapter generation skipped",
} as const;

/** Everything the runner touches outside itself, so a test can drive it without a network or a process. */
export interface GenerationDeps {
	resolveDiff: (options: DiffScopeOptions) => Promise<ResolvedFilteredDiff>;
	spawnChild: (job: JobRequest) => SpawnedChild;
	db: StageDb;
	now: () => number;
}

/**
 * Decides whether this job needs an agent at all. The diff is resolved in-process
 * against the job's own clone — never the daemon's working directory, which is
 * wherever the user happened to start the server — and a diff too small to be
 * worth clustering becomes a run directly, with no agent spawned.
 */
export async function runGenerationJob(
	job: JobRequest,
	onProgress: (progress: JobProgress) => void,
	deps: GenerationDeps,
): Promise<string> {
	const startedAt = deps.now();
	const diff = await deps.resolveDiff({ cwd: job.repoRoot, pr: job.prUrl });

	if (shouldGenerateChapters(diff.stats)) {
		return new AgentSession({
			job,
			onProgress,
			now: deps.now,
			spawnChild: deps.spawnChild,
			timeoutMs: AGENT_TIMEOUT_MS,
			killGraceMs: KILL_GRACE_MS,
			errorGraceMs: ERROR_GRACE_MS,
			drainMs: STDOUT_DRAIN_MS,
		}).run();
	}

	// Without a snapshot the dashboard shows a job going queued → done with no
	// activity, and JobManager has nothing to stamp the end time on.
	onProgress(skippedProgress(startedAt, ACTIVITY_STATE.RUNNING));
	const { runId } = insertChaptersFile(
		deps.db,
		buildSyntheticChaptersFile(diff),
		readRepoContext(job.repoRoot),
		diff.prNumber,
	);
	onProgress(skippedProgress(startedAt, ACTIVITY_STATE.DONE));
	return runId;
}

function skippedProgress(startedAt: number, state: ActivityState): JobProgress {
	return {
		startedAt,
		// JobManager.recordEnd owns this stamp — it is the only place that knows the job is over.
		endedAt: null,
		resolvedModel: null,
		turns: 0,
		phase: GENERATION_PHASE.IMPORT,
		activity: [{ tool: SKIPPED_ACTIVITY.TOOL, target: SKIPPED_ACTIVITY.TARGET, state }],
	};
}

/** The real runner: the daemon's own clock, spawn, and database. */
export function claudeRunner(
	job: JobRequest,
	onProgress: (progress: JobProgress) => void,
): Promise<string> {
	return runGenerationJob(job, onProgress, {
		resolveDiff: resolveFilteredDiff,
		spawnChild: spawnClaude,
		db: getDb(),
		now: () => Date.now(),
	});
}
