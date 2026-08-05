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

const GENERATING: PrResolution = { state: "generating", jobId: "job-1" };
const NEEDS_GENERATION: PrResolution = { state: "needs-generation" };

const progress: JobProgress = {
	startedAt: 1,
	endedAt: null,
	resolvedModel: "claude-sonnet-4-5-20250929",
	turns: 4,
	phase: "analyze",
	activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
};

describe("deriveResolverView job snapshot", () => {
	it("carries the model and a live clock while the job runs", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ progress }),
				pollError: null,
				generationError: null,
			}),
		).toEqual({
			tag: "progress",
			queuePosition: null,
			snapshot: { requestedModel: "sonnet", progress, isRunning: true },
		});
	});

	it("stops the clock on a succeeded job still waiting to navigate away", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "succeeded", runId: "run-1", progress }),
				pollError: null,
				generationError: null,
			}),
		).toEqual({
			tag: "progress",
			queuePosition: null,
			snapshot: { requestedModel: "sonnet", progress, isRunning: false },
		});
	});

	it("keeps the last snapshot but stops the clock on a failed job", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "failed", error: "boom", progress }),
				pollError: null,
				generationError: null,
			}),
		).toEqual({
			tag: "failed",
			error: "boom",
			snapshot: { requestedModel: "sonnet", progress, isRunning: false },
		});
	});

	it("has no snapshot before a job is adopted", () => {
		expect(
			deriveResolverView({
				resolution: NEEDS_GENERATION,
				resolutionError: null,
				job: null,
				pollError: null,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, snapshot: null });
	});

	it("carries no detail when a failed job reports no error, leaving the card's headline", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "failed", error: null }),
				pollError: null,
				generationError: null,
			}),
		).toEqual({
			tag: "failed",
			error: null,
			snapshot: { requestedModel: "sonnet", progress: null, isRunning: false },
		});
	});
});
