import { randomUUID } from "node:crypto";
import type { JobProgress } from "@stagereview/types/generation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAIN_MS, makeSession, successResult } from "./agent-session-fixture.js";
import { FakeChild } from "./fake-child-process.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("AgentSession progress reporting", () => {
	it("pushes a first snapshot on spawn and one per stream line", async () => {
		const child = new FakeChild();
		const seen: JobProgress[] = [];
		const run = makeSession(child, { onProgress: (progress) => seen.push(progress) }).run();
		child.emit("spawn");
		expect(seen).toHaveLength(1);

		child.emitLine({ type: "system", subtype: "init", model: "claude-sonnet-4-5" });
		await vi.advanceTimersByTimeAsync(0);
		expect(seen.at(-1)?.resolvedModel).toBe("claude-sonnet-4-5");

		const runId = randomUUID();
		child.emitLine(successResult(runId));
		await vi.advanceTimersByTimeAsync(0);
		child.close(0);
		await vi.advanceTimersByTimeAsync(0);
		await expect(run).resolves.toBe(runId);
	});

	it("stops reporting once the run has settled", async () => {
		const child = new FakeChild();
		const seen: JobProgress[] = [];
		const run = makeSession(child, { onProgress: (progress) => seen.push(progress) }).run();
		child.emit("spawn");
		child.emitLine(successResult(randomUUID()));
		await vi.advanceTimersByTimeAsync(0);

		// exit without close: the drain window settles the run while stdout, and the
		// readline interface reading it, are both still open.
		child.exit(0);
		await vi.advanceTimersByTimeAsync(DRAIN_MS);
		await run;
		const after = seen.length;

		child.emitLine({ type: "assistant", message: { content: [] } });
		await vi.advanceTimersByTimeAsync(0);
		// A terminal job whose activity keeps changing is a job the dashboard shows
		// as still working.
		expect(seen).toHaveLength(after);
	});
});
