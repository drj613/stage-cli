import type { GenerationJob, JobProgress } from "@stagereview/types/generation";
import type { PrResolution } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { deriveResolverView } from "../resolver-view";

function job(overrides: Partial<GenerationJob>): GenerationJob {
	return {
		id: "job-1",
		prUrls: ["https://github.com/o/r/pull/1"],
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
const POLL_404 = "GET /api/generate/job-1 failed: 404";

const progress: JobProgress = {
	startedAt: 1,
	endedAt: null,
	resolvedModel: "claude-sonnet-4-5-20250929",
	turns: 4,
	phase: "analyze",
	activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
};

const FROZEN = { requestedModel: "sonnet", progress, isRunning: false };

describe("deriveResolverView poll error", () => {
	it("does not turn a succeeded job into a failure", () => {
		// The run is over and its cached outcome is the truth; a poll failing
		// afterwards says nothing about it.
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "succeeded", runId: "run-1", progress }),
				pollError: POLL_404,
				generationError: null,
			}),
		).toEqual({ tag: "progress", queuePosition: null, snapshot: FROZEN });
	});

	it("keeps a failed job's own cause instead of replacing it with the transport error", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "failed", error: "agent exited with code 1", progress }),
				pollError: POLL_404,
				generationError: null,
			}),
		).toEqual({ tag: "failed", error: "agent exited with code 1", snapshot: FROZEN });
	});

	it("outranks a cached job that is still live, which nothing will report on again", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "running", progress }),
				pollError: POLL_404,
				generationError: POLL_404,
			}),
		).toEqual({ tag: "failed", error: POLL_404, snapshot: FROZEN });
	});

	it("outranks a queued job too, which cannot report its place in line either", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: job({ status: "queued", queuePosition: 3 }),
				pollError: POLL_404,
				generationError: POLL_404,
			}),
		).toEqual({
			tag: "failed",
			error: POLL_404,
			snapshot: { requestedModel: "sonnet", progress: null, isRunning: false },
		});
	});

	it("surfaces itself with no snapshot when nothing was ever cached", () => {
		expect(
			deriveResolverView({
				resolution: GENERATING,
				resolutionError: null,
				job: null,
				pollError: "job not found",
				generationError: "job not found",
			}),
		).toEqual({ tag: "failed", error: "job not found", snapshot: null });
	});
});
