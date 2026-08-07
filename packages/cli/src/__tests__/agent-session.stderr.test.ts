import { afterEach, describe, expect, it, vi } from "vitest";
import {
	STDERR_LINE_LIMIT,
	STDERR_TAIL_LINES,
	STDERR_TEE_LINES,
} from "../generation/agent-session.js";
import { captureLog, flush, JOB, makeSession } from "./agent-session-fixture.js";
import { FakeChild } from "./fake-child-process.js";

const TAG = `[stage:generate] ${JOB.prUrls[0]}`;

describe("AgentSession stderr", () => {
	afterEach(() => vi.restoreAllMocks());

	it("tees each line to the terminal, tagged with the PR", async () => {
		const logged = captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const failure = expect(run).rejects.toThrow();
		child.emit("spawn");
		child.stderr.write("npm warn deprecated\nfetch failed\n");
		await flush();
		expect(logged).toEqual([`${TAG} npm warn deprecated`, `${TAG} fetch failed`]);

		child.close(0);
		await failure;
	});

	it("stops teeing once the cap is reached", async () => {
		const logged = captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const failure = expect(run).rejects.toThrow();
		child.emit("spawn");
		for (let i = 0; i < STDERR_TEE_LINES + 5; i += 1) child.stderr.write(`line ${i}\n`);
		await flush();
		expect(logged).toHaveLength(STDERR_TEE_LINES);

		child.close(0);
		await failure;
	});

	it("appends only the tail of stderr to a failure message", async () => {
		captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		for (let i = 1; i <= STDERR_TAIL_LINES + 3; i += 1) child.stderr.write(`line ${i}\n`);
		await flush();
		child.close(1);

		expect(await message).toContain("agent exited with code 1");
		expect(await message).toContain(`line ${STDERR_TAIL_LINES + 3}`);
		expect(await message).toContain("line 4"); // the oldest line still in the window
		expect(await message).not.toContain("line 1\n");
		expect(await message).not.toContain("line 3\n");
	});

	it("bounds each line however large it arrives", async () => {
		const logged = captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		child.stderr.write(`${"x".repeat(2_000_000)}\n`);
		await flush();
		child.close(1);

		expect(logged[0]?.length).toBeLessThanOrEqual(`${TAG} `.length + STDERR_LINE_LIMIT);
		expect((await message).length).toBeLessThan(STDERR_LINE_LIMIT * 2);
	});

	it("truncates a huge line before sanitizing it, not after", async () => {
		captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const failure = expect(run).rejects.toThrow();
		child.emit("spawn");

		// Sanitizing 5 MB before trimming it blocks the event loop for about a
		// second — measured — and this server has one thread to give. Trimming
		// first costs single-digit milliseconds, so the gap is ~100x and the
		// threshold below is not a close call.
		const started = performance.now();
		child.stderr.write(`${"x".repeat(5 * 1024 * 1024)}\n`);
		await flush();
		expect(performance.now() - started).toBeLessThan(200);

		child.close(1);
		await failure;
	});
});
