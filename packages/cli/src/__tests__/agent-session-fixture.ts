import { GENERATION_MODEL } from "@stagereview/types/generation";
import { vi } from "vitest";
import { AgentSession, type AgentSessionOptions } from "../generation/agent-session.js";
import type { JobRequest } from "../generation/job-manager.js";
import type { FakeChild } from "./fake-child-process.js";

export const JOB: JobRequest = {
	prUrl: "https://github.com/acme/widgets/pull/42",
	repoRoot: "/repo",
	requestedModel: GENERATION_MODEL.SONNET,
};

export const TIMEOUT_MS = 1_000;
export const KILL_GRACE_MS = 100;
export const ERROR_GRACE_MS = 50;
export const DRAIN_MS = 200;

export function makeSession(child: FakeChild, overrides: Partial<AgentSessionOptions> = {}) {
	return new AgentSession({
		job: JOB,
		onProgress: () => {},
		now: () => 1_700_000_000_000,
		spawnChild: () => child,
		timeoutMs: TIMEOUT_MS,
		killGraceMs: KILL_GRACE_MS,
		errorGraceMs: ERROR_GRACE_MS,
		drainMs: DRAIN_MS,
		...overrides,
	});
}

/** Lets queued microtasks and stream reads flush. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function successResult(runId: string) {
	return { type: "result", subtype: "success", result: `Done.\n${runId}`, num_turns: 5 };
}

/**
 * Silences the session's terminal output and returns the lines it wrote. Restore
 * with `vi.restoreAllMocks()`.
 */
export function captureLog(): string[] {
	const lines: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	return lines;
}

/** Records every settlement, so a test can prove there was exactly one. */
export function track(run: Promise<string>): string[] {
	const settlements: string[] = [];
	run.then(
		(runId) => settlements.push(`resolve:${runId}`),
		(err: Error) => settlements.push(`reject:${err.message}`),
	);
	return settlements;
}
