import type { GenerationJob, GenerationModel, JobProgress } from "@stagereview/types/generation";
import { isTerminalJobStatus, JOB_STATUS } from "@stagereview/types/generation";
import { PR_RESOLUTION, type PrResolution } from "@stagereview/types/pull-requests";

/**
 * Everything a card says about the job behind it, as one group rather than
 * three loose props: `requestedModel` is the label until `progress` carries a
 * resolved id, and `isRunning` is what keeps the elapsed clock off a job that
 * can no longer advance.
 */
export interface JobSnapshot {
	requestedModel: GenerationModel;
	/** Null while queued, and for a job whose process never spawned. */
	progress: JobProgress | null;
	isRunning: boolean;
}

function snapshotOf(job: GenerationJob, isRunning: boolean): JobSnapshot {
	return { requestedModel: job.requestedModel, progress: job.progress, isRunning };
}

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
	/** `error` is the detail under the card's own headline, absent when nothing said why. */
	| { tag: "failed"; error: string | null; snapshot: JobSnapshot | null }
	| { tag: "stale"; runId: string }
	| { tag: "no-clone"; nameWithOwner: string }
	| { tag: "progress"; queuePosition: number | null; snapshot: JobSnapshot | null };

export interface ResolverViewInput {
	resolution: PrResolution | undefined;
	resolutionError: unknown;
	job: GenerationJob | null;
	/** The job poll's own failure message, kept separate because it says nothing about the job it arrives with. */
	pollError: string | null;
	/** Precomputed by usePrResolution: startError, job.error, or the resolution's own reported error, in that precedence. */
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
	pollError,
	generationError,
}: ResolverViewInput): ResolverView {
	if (resolutionError) {
		return { tag: "error", message: describeResolutionError(resolutionError) };
	}
	if (resolution === undefined) {
		return { tag: "loading" };
	}

	// A poll that errored on a job with work left to do leaves nothing to report
	// that job again: the query doesn't retry, so it stays dead until a window
	// focus or Retry refetches it, and neither is guaranteed. Rendering it as live
	// progress would spin with nothing to click, so the error outranks it — and
	// the snapshot goes along frozen, since a failed poll is no evidence the job
	// is still moving.
	//
	// A job already terminal in cache is the exception: it has nothing left to
	// advance, and its own recorded outcome — success or its real cause of death —
	// stays the truth no matter what the transport does afterwards.
	if (pollError !== null && (job === null || !isTerminalJobStatus(job.status))) {
		return {
			tag: "failed",
			error: pollError,
			snapshot: job === null ? null : snapshotOf(job, false),
		};
	}

	// A job object present means a job has been adopted (auto-start, Retry, or
	// Regenerate) and is the freshest signal available — it outranks whatever
	// the resolution reported before this job existed.
	if (job !== null) {
		if (job.status === JOB_STATUS.FAILED) {
			return {
				tag: "failed",
				error: job.error ?? generationError,
				snapshot: snapshotOf(job, false),
			};
		}
		return {
			tag: "progress",
			queuePosition: job.status === JOB_STATUS.QUEUED ? job.queuePosition : null,
			snapshot: snapshotOf(job, !isTerminalJobStatus(job.status)),
		};
	}

	if (resolution.state === PR_RESOLUTION.FAILED || generationError !== null) {
		return { tag: "failed", error: generationError, snapshot: null };
	}
	if (resolution.state === PR_RESOLUTION.STALE) {
		return { tag: "stale", runId: resolution.runId };
	}
	if (resolution.state === PR_RESOLUTION.NO_CLONE) {
		return { tag: "no-clone", nameWithOwner: resolution.nameWithOwner };
	}
	// ready (pre-navigate), needs-generation, or generating with no job data yet.
	return { tag: "progress", queuePosition: null, snapshot: null };
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
