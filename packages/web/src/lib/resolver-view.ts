import type { GenerationJob, JobProgress } from "@stagereview/types/generation";
import { JOB_STATUS } from "@stagereview/types/generation";
import { PR_RESOLUTION, type PrResolution } from "@stagereview/types/pull-requests";

/**
 * What the resolver page should render, as a single tagged union with
 * priority visible by construction. A live job's own terminal status always
 * outranks the resolution's last-known state: TanStack Query keeps the last
 * job snapshot cached, so once a job is adopted (auto-start, Retry, or
 * Regenerate) `job` stays non-null even after it fails — checking
 * `resolution.state` alone (or gating on `job === null`) would strand a
 * failed job behind whatever card the resolution reported before the job
 * existed.
 */
export type ResolverView =
	| { tag: "loading" }
	| { tag: "error"; message: string }
	| { tag: "failed"; error: string; progress: JobProgress | null }
	| { tag: "stale"; runId: string }
	| { tag: "no-clone"; nameWithOwner: string }
	| { tag: "progress"; queuePosition: number | null; progress: JobProgress | null };

export interface ResolverViewInput {
	resolution: PrResolution | undefined;
	resolutionError: unknown;
	job: GenerationJob | null;
	/** Precomputed by usePrResolution: startError, pollError, job.error, or the resolution's own reported error, in that precedence. */
	generationError: string | null;
}

function describeResolutionError(resolutionError: unknown): string {
	return resolutionError instanceof Error
		? resolutionError.message
		: "The Stage server didn't respond.";
}

export function deriveResolverView({
	resolution,
	resolutionError,
	job,
	generationError,
}: ResolverViewInput): ResolverView {
	if (resolutionError) {
		return { tag: "error", message: describeResolutionError(resolutionError) };
	}
	if (resolution === undefined) {
		return { tag: "loading" };
	}

	// A job object present means a job has been adopted (auto-start, Retry, or
	// Regenerate) and is the freshest signal available — it outranks whatever
	// the resolution reported before this job existed.
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

	if (resolution.state === PR_RESOLUTION.FAILED || generationError !== null) {
		return { tag: "failed", error: generationError ?? "", progress: null };
	}
	if (resolution.state === PR_RESOLUTION.STALE) {
		return { tag: "stale", runId: resolution.runId };
	}
	if (resolution.state === PR_RESOLUTION.NO_CLONE) {
		return { tag: "no-clone", nameWithOwner: resolution.nameWithOwner };
	}
	// ready (pre-navigate), needs-generation, or generating with no job data yet.
	return { tag: "progress", queuePosition: null, progress: null };
}

/**
 * Compiler-enforced exhaustiveness check for a `switch` over `ResolverView`
 * (or any other closed union). Adding a new `tag` without a matching `case`
 * makes `value` fail to narrow to `never` here, so the switch stops
 * compiling instead of silently falling through to a blank render.
 */
export function assertUnreachable(value: never): never {
	throw new Error(`Unreachable resolver view: ${JSON.stringify(value)}`);
}
