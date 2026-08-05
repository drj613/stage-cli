import { randomUUID } from "node:crypto";
import { GENERATION_MODEL, type JobProgress } from "@stagereview/types/generation";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../generation/agent-session.js";
import type { JobRequest } from "../generation/job-manager.js";
import { FakeChild } from "./fake-child-process.js";

const JOB: JobRequest = {
	prUrl: "https://github.com/acme/widgets/pull/42",
	repoRoot: "/repo",
	requestedModel: GENERATION_MODEL.SONNET,
};

const TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 100;
const ERROR_GRACE_MS = 50;

function makeSession(child: FakeChild, onProgress: (p: JobProgress) => void = () => {}) {
	return new AgentSession({
		job: JOB,
		onProgress,
		now: () => 1_700_000_000_000,
		spawnChild: () => child,
		timeoutMs: TIMEOUT_MS,
		killGraceMs: KILL_GRACE_MS,
		errorGraceMs: ERROR_GRACE_MS,
	});
}

/** Lets queued microtasks and stream reads flush. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function successResult(runId: string) {
	return { type: "result", subtype: "success", result: `Done.\n${runId}`, num_turns: 5 };
}

describe("AgentSession settlement", () => {
	it("resolves with the runId only after close", async () => {
		const runId = randomUUID();
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(runId));
		await flush();

		let settled = false;
		void run.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false); // result alone must not settle

		child.close(0);
		await expect(run).resolves.toBe(runId);
	});

	it("pushes a first snapshot immediately after spawn", async () => {
		const child = new FakeChild();
		const snapshots: JobProgress[] = [];
		const session = makeSession(child, (p) => snapshots.push(p));
		const run = session.run();
		child.emit("spawn");
		await flush();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ resolvedModel: null, turns: 0, phase: "prep" });

		child.close(1);
		await expect(run).rejects.toThrow();
	});

	it("rejects on a spawn error followed by close, settling once", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("error", new Error("spawn claude ENOENT"));
		child.close(null);
		await expect(run).rejects.toThrow(/ENOENT/);
	});

	it("rejects a pre-spawn error that never closes, via the grace period", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("error", new Error("spawn claude EACCES"));
		await expect(run).rejects.toThrow(/EACCES/);
	});

	it("stays pending on a post-spawn error that never closes", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emit("error", new Error("kill ESRCH"));

		let settled = false;
		void run.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, ERROR_GRACE_MS * 3));
		expect(settled).toBe(false); // releasing the queue here could start a second agent
		expect(child.signals).toContain("SIGKILL");

		child.close(null, "SIGKILL");
		await expect(run).rejects.toThrow();
	});

	it("rejects when the process exits cleanly with no result event", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.close(0);
		await expect(run).rejects.toThrow(/without a result event/);
	});

	it("rejects a success result followed by a non-zero close", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(randomUUID()));
		await flush();
		child.close(3);
		await expect(run).rejects.toThrow(/exited with code 3/);
	});

	it("rejects when terminated by a signal we did not send", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.close(null, "SIGSEGV");
		await expect(run).rejects.toThrow(/SIGSEGV/);
	});

	it("settles once when two result events arrive", async () => {
		const lastRunId = randomUUID();
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(randomUUID()));
		child.emitLine(successResult(lastRunId));
		await flush();
		child.close(0);
		// StreamReducer keeps the latest result event, so that is the one we settle on.
		await expect(run).resolves.toBe(lastRunId);
	});

	it("reports an error result using its diagnostic fields", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine({ type: "result", subtype: "error_max_turns", is_error: true });
		await flush();
		child.close(0);
		await expect(run).rejects.toThrow(/hit its turn limit/);
	});

	it("rejects when the final line is not a runId, without echoing it", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine({ type: "result", subtype: "success", result: "Here is your secret token." });
		await flush();
		child.close(0);
		await expect(run).rejects.toThrow("Agent did not return a valid runId.");
		await expect(run).rejects.not.toThrow(/secret token/);
	});

	it("mentions dropped lines in a failure message", async () => {
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.stdout.write("{ not json\n");
		await flush();
		child.close(0);
		await expect(run).rejects.toThrow(/1 unreadable line/);
	});
});

describe("AgentSession timeout", () => {
	it("escalates SIGTERM to SIGKILL and stays pending until close", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			const session = makeSession(child);
			const run = session.run();
			let settled = false;
			void run.catch(() => {
				settled = true;
			});
			child.emit("spawn");

			await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
			expect(child.signals).toEqual(["SIGTERM"]);
			expect(settled).toBe(false);

			await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
			expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
			expect(settled).toBe(false); // still alive — the queue must not advance

			child.close(null, "SIGKILL");
			await expect(run).rejects.toThrow(/timed out/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a timeout, not a signal, when the child dies from our SIGTERM", async () => {
		vi.useFakeTimers();
		try {
			const child = new FakeChild();
			const session = makeSession(child);
			const run = session.run();
			const assertion = expect(run).rejects.toThrow(/timed out/);
			child.emit("spawn");
			await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
			child.close(null, "SIGTERM");
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});
