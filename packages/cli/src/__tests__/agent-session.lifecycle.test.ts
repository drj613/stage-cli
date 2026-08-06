import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureLog,
	DRAIN_MS,
	ERROR_GRACE_MS,
	KILL_GRACE_MS,
	makeSession,
	successResult,
	TIMEOUT_MS,
	track,
} from "./agent-session-fixture.js";
import { FakeChild } from "./fake-child-process.js";

// Every test here drives timers by hand.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("AgentSession timeout", () => {
	it("escalates SIGTERM to SIGKILL and stays pending until close", async () => {
		const child = new FakeChild();
		const run = makeSession(child).run();
		const settlements = track(run);
		child.emit("spawn");

		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(child.signals).toEqual(["SIGTERM"]);
		expect(settlements).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(settlements).toHaveLength(0); // still alive — the queue must not advance

		child.close(null, "SIGKILL");
		await expect(run).rejects.toThrow(/timed out/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a timeout, not a signal, when the child dies from our SIGTERM", async () => {
		const child = new FakeChild();
		const run = makeSession(child).run();
		const assertion = expect(run).rejects.toThrow(/timed out/);
		child.emit("spawn");
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		child.close(null, "SIGTERM");
		await assertion;
	});

	it("does not escalate when the timeout finds an already-reaped child", async () => {
		const log = captureLog();
		const child = new FakeChild();
		// A drain window longer than the timeout is the only way both fire.
		const run = makeSession(child, { drainMs: TIMEOUT_MS * 3 }).run();
		const settlements = track(run);
		child.emit("spawn");
		child.exit(0);

		await vi.advanceTimersByTimeAsync(TIMEOUT_MS + KILL_GRACE_MS);
		expect(child.signals).toEqual([]); // a signal cannot land on a reaped pid
		expect(log.join("\n")).toContain("already exited");
		expect(log.join("\n")).not.toContain("SIGKILL"); // escalating to a dead pid is pointless
		expect(settlements).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3);
		expect(settlements).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("AgentSession stdout drain", () => {
	it("settles on the exit status when close never arrives", async () => {
		const child = new FakeChild();
		const run = makeSession(child).run();
		const settlements = track(run);
		child.emit("spawn");
		child.exit(0);

		await vi.advanceTimersByTimeAsync(DRAIN_MS - 1);
		expect(settlements).toHaveLength(0); // stdout still gets its chance

		await vi.advanceTimersByTimeAsync(1);
		expect(settlements).toEqual(["reject:agent exited without a result event"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resolves after the drain when the result arrived but stdout stays open", async () => {
		const runId = randomUUID();
		const child = new FakeChild();
		const run = makeSession(child).run();
		child.emit("spawn");
		child.emitLine(successResult(runId));
		await vi.advanceTimersByTimeAsync(0);
		child.exit(0);
		await vi.advanceTimersByTimeAsync(DRAIN_MS);
		await expect(run).resolves.toBe(runId);
	});

	it("reports the exit code when a failed child never closes stdout", async () => {
		const child = new FakeChild();
		const run = makeSession(child).run();
		const failure = expect(run).rejects.toThrow(/exited with code 4/);
		child.emit("spawn");
		child.exit(4);
		await vi.advanceTimersByTimeAsync(DRAIN_MS);
		await failure;
	});

	it("prefers close over the drain window when both are available", async () => {
		const child = new FakeChild();
		const run = makeSession(child).run();
		const settlements = track(run);
		child.emit("spawn");
		child.close(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(settlements).toHaveLength(1); // settled well before drainMs elapsed
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("AgentSession post-settlement quiet", () => {
	it("leaves no timers behind on any settlement path", async () => {
		const succeeded = new FakeChild();
		const run = makeSession(succeeded).run();
		succeeded.emit("spawn");
		succeeded.emitLine(successResult(randomUUID()));
		await vi.advanceTimersByTimeAsync(0);
		succeeded.close(0);
		await vi.advanceTimersByTimeAsync(0);
		await run;
		expect(vi.getTimerCount()).toBe(0);

		const failed = new FakeChild();
		const failedRun = makeSession(failed).run();
		const failure = expect(failedRun).rejects.toThrow();
		failed.emit("spawn");
		failed.close(2);
		await vi.advanceTimersByTimeAsync(0);
		await failure;
		expect(vi.getTimerCount()).toBe(0);

		const errored = new FakeChild();
		const erroredRun = makeSession(errored).run();
		const spawnFailure = expect(erroredRun).rejects.toThrow();
		errored.emit("error", new Error("spawn claude ENOENT"));
		await vi.advanceTimersByTimeAsync(ERROR_GRACE_MS);
		await spawnFailure;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("schedules nothing when an error or exit arrives after settlement", async () => {
		const child = new FakeChild();
		const run = makeSession(child).run();
		const settlements = track(run);
		child.close(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(settlements).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);

		// Each of these schedules a timer on an unsettled session — the grace timer
		// and the drain timer respectively. After settlement they must do nothing;
		// a timer left here fires against a finished run and is never cleared.
		child.emit("error", new Error("late boom"));
		expect(vi.getTimerCount()).toBe(0);
		child.emit("exit", 9, null);
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 4);
		expect(settlements).toHaveLength(1);
	});

	it("says nothing more once a spawned run has settled", async () => {
		const log = captureLog();
		const runId = randomUUID();
		const child = new FakeChild();
		const run = makeSession(child).run();
		child.emit("spawn");
		child.emitLine(successResult(runId));
		await vi.advanceTimersByTimeAsync(0);
		child.close(0);
		await vi.advanceTimersByTimeAsync(0);
		await expect(run).resolves.toBe(runId);
		log.length = 0;

		child.emit("error", new Error("late boom"));
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 4);
		expect(log).toEqual([]); // no "process error after spawn" for a finished run
		expect(child.signals).toEqual([]);
	});
});
