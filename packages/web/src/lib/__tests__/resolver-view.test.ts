import type { GenerationJob } from "@stagereview/types/generation";
import type { PrResolution } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { deriveResolverView, type ResolverViewInput } from "../resolver-view";

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

/** A healthy poll and no start failure — the boring baseline every case varies from. */
function input(overrides: Partial<ResolverViewInput>): ResolverViewInput {
	return {
		resolution: undefined,
		resolutionError: null,
		job: null,
		pollError: null,
		generationError: null,
		...overrides,
	};
}

const LIVE = { requestedModel: "sonnet", progress: null, isRunning: true };
const FROZEN = { requestedModel: "sonnet", progress: null, isRunning: false };

const READY: PrResolution = { state: "ready", runId: "run-1" };
const STALE: PrResolution = { state: "stale", runId: "run-1", headSha: "abc" };
const FAILED: PrResolution = { state: "failed", jobId: "job-1", error: "agent crashed" };
const NEEDS_GENERATION: PrResolution = { state: "needs-generation" };
const NO_CLONE: PrResolution = { state: "no-clone", nameWithOwner: "o/r" };
const GENERATING: PrResolution = { state: "generating", jobId: "job-1" };

describe("deriveResolverView", () => {
	it("is loading while the resolution hasn't arrived", () => {
		expect(deriveResolverView(input({}))).toEqual({ tag: "loading" });
	});

	it("surfaces a resolution fetch error", () => {
		expect(deriveResolverView(input({ resolutionError: new Error("network down") }))).toEqual({
			tag: "error",
			message: "network down",
		});
	});

	it("a job that polls to FAILED produces the failed card, not a stuck spinner", () => {
		// This is the regression the ordered-if dispatch got wrong: once a job
		// is adopted, `job` stays non-null forever (TanStack Query keeps the
		// last snapshot), so a naive `job === null` gate can never re-fire.
		expect(
			deriveResolverView(
				input({
					resolution: GENERATING,
					job: job({ status: "failed", error: "agent crashed mid-run" }),
				}),
			),
		).toEqual({ tag: "failed", error: "agent crashed mid-run", snapshot: FROZEN });
	});

	it("prefers the job's own error over generationError when both are present", () => {
		expect(
			deriveResolverView(
				input({
					resolution: GENERATING,
					job: job({ status: "failed", error: "job error" }),
					generationError: "stale generationError",
				}),
			),
		).toEqual({ tag: "failed", error: "job error", snapshot: FROZEN });
	});

	it("a live running job shows progress after Retry from a failed resolution", () => {
		expect(
			deriveResolverView(input({ resolution: FAILED, job: job({ status: "running" }) })),
		).toEqual({ tag: "progress", queuePosition: null, snapshot: LIVE });
	});

	it("a live queued job shows progress after Regenerate from a stale resolution", () => {
		expect(
			deriveResolverView(
				input({ resolution: STALE, job: job({ status: "queued", queuePosition: 2 }) }),
			),
		).toEqual({ tag: "progress", queuePosition: 2, snapshot: LIVE });
	});

	it("an untouched stale resolution (no job yet) shows the stale card", () => {
		expect(deriveResolverView(input({ resolution: STALE }))).toEqual({
			tag: "stale",
			runId: "run-1",
		});
	});

	it("an untouched failed resolution (no job yet) shows the failed card with the server's error", () => {
		expect(
			deriveResolverView(input({ resolution: FAILED, generationError: "agent crashed" })),
		).toEqual({ tag: "failed", error: "agent crashed", snapshot: null });
	});

	it("maps ready to progress (the page navigates away separately)", () => {
		expect(deriveResolverView(input({ resolution: READY }))).toEqual({
			tag: "progress",
			queuePosition: null,
			snapshot: null,
		});
	});

	it("maps no-clone to the no-clone card", () => {
		expect(deriveResolverView(input({ resolution: NO_CLONE }))).toEqual({
			tag: "no-clone",
			nameWithOwner: "o/r",
		});
	});

	it("maps needs-generation to progress", () => {
		expect(deriveResolverView(input({ resolution: NEEDS_GENERATION }))).toEqual({
			tag: "progress",
			queuePosition: null,
			snapshot: null,
		});
	});

	it("maps generating with no job data yet to progress", () => {
		expect(deriveResolverView(input({ resolution: GENERATING }))).toEqual({
			tag: "progress",
			queuePosition: null,
			snapshot: null,
		});
	});
});
