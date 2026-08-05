// @vitest-environment happy-dom
import type { JobProgress } from "@stagereview/types/generation";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressSummary } from "../progress-summary";

function progress(overrides: Partial<JobProgress> = {}): JobProgress {
	return {
		startedAt: Date.now() - 90_000,
		endedAt: null,
		resolvedModel: "claude-sonnet-4-5-20250929",
		turns: 14,
		phase: "write",
		activity: [],
		...overrides,
	};
}

describe("ProgressSummary", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("counts up from startedAt while the job is running", () => {
		render(
			<ProgressSummary
				requestedModel="sonnet"
				progress={progress({ startedAt: Date.now() - 90_000 })}
				isRunning
			/>,
		);
		expect(screen.getByText("Sonnet 4.5 · 1m 30s · 14 turns")).toBeTruthy();
	});

	it("shows a terminal job's recorded duration, and stops counting", () => {
		const startedAt = Date.now() - 300_000;
		render(
			<ProgressSummary
				requestedModel="sonnet"
				progress={progress({ startedAt, endedAt: startedAt + 102_000 })}
				isRunning={false}
			/>,
		);
		expect(screen.getByText("Sonnet 4.5 · 1m 42s · 14 turns")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(5_000);
		});
		expect(screen.getByText("Sonnet 4.5 · 1m 42s · 14 turns")).toBeTruthy();
	});

	it("omits the duration for a terminal job that recorded no end time", () => {
		render(
			<ProgressSummary
				requestedModel="sonnet"
				progress={progress({ startedAt: Date.now() - 90_000, endedAt: null })}
				isRunning={false}
			/>,
		);
		expect(screen.getByText("Sonnet 4.5 · 14 turns")).toBeTruthy();
	});

	it("shows the requested model alone before the process has spawned", () => {
		render(<ProgressSummary requestedModel="opus" progress={null} isRunning />);
		expect(screen.getByText("Opus")).toBeTruthy();
	});
});
