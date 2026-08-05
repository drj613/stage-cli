import type { GenerationJob, JobProgress } from "@stagereview/types/generation";
import type { PrResolution } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { deriveResolverView } from "../resolver-view";

function job(overrides: Partial<GenerationJob>): GenerationJob {
	return {
		id: "job-1",
		prUrl: "https://github.com/o/r/pull/1",
		status: "running",
		requestedModel: "sonnet",
		runId: null,
		error: null,
		queuePosition: null,
		progress: null,
		...overrides,
	};
}

const READY: PrResolution = { state: "ready", runId: "run-1" };
const STALE: PrResolution = { state: "stale", runId: "run-1", headSha: "abc" };
const FAILED: PrResolution = { state: "failed", jobId: "job-1", error: "agent crashed" };
const NEEDS_GENERATION: PrResolution = { state: "needs-generation" };
const NO_CLONE: PrResolution = { state: "no-clone", nameWithOwner: "o/r" };
const GENERATING: PrResolution = { state: "generating", jobId: "job-1" };

describe("deriveResolverView", () => {
	it("is loading while the resolution hasn't arrived", () => {
		expect(
			deriveResolverView({
				resolution: undefined,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "loading" });
	});

	it("surfaces a resolution fetch error", () => {
		expect(
			deriveResolverView({
				resolution: undefined,
				resolutionError: new Error("network down"),
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "error", message: "network down" });
	});

	it("a job that polls to FAILED produces the failed card, not a stuck spinner", () => {
		// This is the regression the ordered-if dispatch got wrong: once a job
		// is adopted, `job` stays non-null forever (TanStack Query keeps the
		// last snapshot), so a naive `job === null` gate can never re-fire.
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "failed", error: "agent crashed mid-run" }),
				generationError: null,
			}),
		).toEqual({ tag: "failed", error: "agent crashed mid-run", progress: null });
	});

	it("prefers the job's own error over generationError when both are present", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "failed", error: "job error" }),
				generationError: "stale generationError",
			}),
		).toEqual({ tag: "failed", error: "job error", progress: null });
	});

	it("a live running job shows progress after Retry from a failed resolution", () => {
		expect(
			deriveResolverView({
				resolution: FAILED,
				resolutionError: null,
				job: job({ status: "running" }),
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress: null });
	});

	it("a live queued job shows progress after Regenerate from a stale resolution", () => {
		expect(
			deriveResolverView({
				resolution: STALE,
				resolutionError: null,
				job: job({ status: "queued", queuePosition: 2 }),
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: 2, progress: null });
	});

	it("an untouched stale resolution (no job yet) shows the stale card", () => {
		expect(
			deriveResolverView({
				resolution: STALE,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "stale", runId: "run-1" });
	});

	it("an untouched failed resolution (no job yet) shows the failed card with the server's error", () => {
		expect(
			deriveResolverView({
				resolution: FAILED,
				resolutionError: null,
				job: null,
				generationError: "agent crashed",
			}),
		).toEqual({ tag: "failed", error: "agent crashed", progress: null });
	});

	it("maps ready to progress (the page navigates away separately)", () => {
		expect(
			deriveResolverView({
				resolution: READY,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress: null });
	});

	it("maps no-clone to the no-clone card", () => {
		expect(
			deriveResolverView({
				resolution: NO_CLONE,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "no-clone", nameWithOwner: "o/r" });
	});

	it("maps needs-generation to progress", () => {
		expect(
			deriveResolverView({
				resolution: NEEDS_GENERATION,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress: null });
	});

	it("maps generating with no job data yet to progress", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress: null });
	});
});

describe("deriveResolverView progress payload", () => {
	const progress: JobProgress = {
		startedAt: 1,
		resolvedModel: "claude-sonnet-4-5-20250929",
		turns: 4,
		phase: "analyze",
		activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
	};

	it("passes the snapshot through on a running job", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ progress }),
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress });
	});

	it("keeps the snapshot on a failed job", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "failed", error: "boom", progress }),
				generationError: null,
			}),
		).toEqual({ tag: "failed", error: "boom", progress });
	});

	it("has no snapshot when there is no job", () => {
		expect(
			deriveResolverView({
				resolution: NEEDS_GENERATION,
				resolutionError: null,
				job: null,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, progress: null });
	});
});
