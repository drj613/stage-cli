import { randomUUID } from "node:crypto";
import type { JobProgress } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import {
	ERROR_GRACE_MS,
	flush,
	makeSession,
	successResult,
	track,
} from "./agent-session-fixture.js";
import { FakeChild } from "./fake-child-process.js";

describe("AgentSession settlement", () => {
	it("resolves with the runId only after close", async () => {
		const runId = randomUUID();
		const child = new FakeChild();
		const session = makeSession(child);
		const run = session.run();
		child.emit("spawn");
		child.emitLine(successResult(runId));
		await flush();

		const settlements = track(run);
		await flush();
		expect(settlements).toHaveLength(0); // result alone must not settle

		child.close(0);
		await expect(run).resolves.toBe(runId);
	});

	it("pushes a first snapshot immediately after spawn", async () => {
		const child = new FakeChild();
		const snapshots: JobProgress[] = [];
		const session = makeSession(child, { onProgress: (p) => snapshots.push(p) });
		const run = session.run();
		child.emit("spawn");
		await flush();
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]).toMatchObject({ resolvedModel: null, turns: 0, phase: "prep" });

		child.close(1);
		await expect(run).rejects.toThrow();
	});

	it("refuses a second run() instead of spawning twice", () => {
		const session = makeSession(new FakeChild());
		void session.run();
		expect(() => session.run()).toThrow(/already/);
	});

	it("refuses a clock JobProgress could not represent", () => {
		for (const now of [() => 0, () => -5, () => 1.5, () => Number.NaN]) {
			expect(() => makeSession(new FakeChild(), { now })).toThrow(/epoch/);
		}
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

		const settlements = track(run);
		await new Promise((resolve) => setTimeout(resolve, ERROR_GRACE_MS * 3));
		expect(settlements).toHaveLength(0); // releasing the queue here could start a second agent
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

	it("sees a final line that arrives without a trailing newline", async () => {
		const runId = randomUUID();
		const child = new FakeChild();
		const run = makeSession(child).run();
		child.emit("spawn");
		child.stdout.write(JSON.stringify(successResult(runId)));
		await flush();
		child.close(0);
		await expect(run).resolves.toBe(runId);
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
