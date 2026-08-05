import {
	GENERATION_MODEL,
	GENERATION_PHASE,
	type GenerationJob,
	type GenerationPhase,
	JOB_STATUS,
} from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { formatJobBadge, formatModelLabel, formatQueueStatus } from "../generation-labels";

function job(over: Partial<GenerationJob> = {}): GenerationJob {
	return {
		id: "job-1",
		prUrl: "https://github.com/o/r/pull/1",
		status: JOB_STATUS.RUNNING,
		requestedModel: GENERATION_MODEL.SONNET,
		runId: null,
		error: null,
		queuePosition: null,
		progress: null,
		...over,
	};
}

function running(phase: GenerationPhase): GenerationJob {
	return job({
		progress: { startedAt: 1, endedAt: null, resolvedModel: null, turns: 0, phase, activity: [] },
	});
}

describe("formatJobBadge", () => {
	it("names the current phase once a snapshot exists", () => {
		expect(formatJobBadge(running(GENERATION_PHASE.PREP))).toBe("Prep");
		expect(formatJobBadge(running(GENERATION_PHASE.ANALYZE))).toBe("Analyze");
		expect(formatJobBadge(running(GENERATION_PHASE.WRITE))).toBe("Write");
		expect(formatJobBadge(running(GENERATION_PHASE.IMPORT))).toBe("Import");
	});

	it("says Starting for a running job whose process has not reported yet", () => {
		expect(formatJobBadge(job({ progress: null }))).toBe("Starting");
	});

	it("shows the place in line for a queued job", () => {
		expect(formatJobBadge(job({ status: JOB_STATUS.QUEUED, queuePosition: 2 }))).toBe("Queued #2");
	});

	it("says Queued without a position when the server reports none", () => {
		expect(formatJobBadge(job({ status: JOB_STATUS.QUEUED, queuePosition: null }))).toBe("Queued");
	});
});

describe("formatQueueStatus", () => {
	it("states the place in line rather than counting jobs ahead", () => {
		// Position 1 is next up with nothing ahead of it, so the old "{n} ahead"
		// phrasing read "1 ahead" for a job at the front of an empty queue.
		expect(formatQueueStatus(1)).toBe("Queued — position 1");
		expect(formatQueueStatus(3)).toBe("Queued — position 3");
	});

	it("says the run is under way once the server reports no position", () => {
		expect(formatQueueStatus(null)).toBe("Chaptering…");
	});
});

describe("formatModelLabel", () => {
	it("falls back to the requested alias before the init event resolves a model", () => {
		expect(formatModelLabel(GENERATION_MODEL.SONNET, null)).toBe("Sonnet");
	});

	it("shortens a dated model id to family and version", () => {
		expect(formatModelLabel(GENERATION_MODEL.SONNET, "claude-sonnet-4-5-20250929")).toBe(
			"Sonnet 4.5",
		);
	});

	it("shortens the older family-last naming scheme the same way", () => {
		expect(formatModelLabel(GENERATION_MODEL.HAIKU, "claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
	});

	it("keeps the family alone when the id carries no version", () => {
		expect(formatModelLabel(GENERATION_MODEL.OPUS, "claude-opus-latest")).toBe("Opus");
	});

	it("falls back to the requested alias when the id has no recognizable family", () => {
		expect(formatModelLabel(GENERATION_MODEL.OPUS, "custom-endpoint-01")).toBe("Opus");
	});

	it("drops a version that doesn't fit the label's budget", () => {
		expect(formatModelLabel(GENERATION_MODEL.SONNET, `claude-sonnet-${"9".repeat(60)}`)).toBe(
			"Sonnet",
		);
		expect(formatModelLabel(GENERATION_MODEL.SONNET, "claude-sonnet-1-2-3-4-5-6-7")).toBe("Sonnet");
	});

	it("falls back to the requested alias for an empty id", () => {
		expect(formatModelLabel(GENERATION_MODEL.OPUS, "")).toBe("Opus");
	});
});
