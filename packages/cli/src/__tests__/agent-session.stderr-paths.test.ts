import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLog, flush, JOB, makeSession } from "./agent-session-fixture.js";
import { FakeChild } from "./fake-child-process.js";

const TAG = `[stage:generate] ${JOB.prUrls[0]}`;

/**
 * The stderr a failed run surfaces goes two places, and only one of them may
 * carry an absolute path: the tail becomes `job.error` and crosses into a
 * browser, while the tee stays on the operator's own terminal.
 */
describe("AgentSession stderr paths", () => {
	afterEach(() => vi.restoreAllMocks());

	it("rewrites a path inside the clone as repo-relative", async () => {
		const logged = captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		child.stderr.write(`ENOENT: no such file or directory, open ${JOB.repoRoot}/src/a.ts\n`);
		await flush();
		child.close(1);

		expect(await message).toContain("ENOENT: no such file or directory, open src/a.ts");
		expect(await message).not.toContain(JOB.repoRoot);
		expect(logged).toEqual([
			`${TAG} ENOENT: no such file or directory, open ${JOB.repoRoot}/src/a.ts`,
		]);
	});

	// The operator owns the machine and needs the whole path to diagnose an
	// out-of-clone failure; the browser does not. Asserting both sinks from one
	// line is what stops them quietly converging on the redacted form again.
	it("redacts the wire but leaves the terminal at full fidelity", async () => {
		const logged = captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		child.stderr.write(`could not stat ${JOB.repoRoot}/lib/deep/thing.ts\n`);
		await flush();
		child.close(1);

		expect(await message).toContain("could not stat lib/deep/thing.ts");
		expect(await message).not.toContain(JOB.repoRoot);
		expect(logged).toEqual([`${TAG} could not stat ${JOB.repoRoot}/lib/deep/thing.ts`]);
	});

	it("reduces a path outside the clone to its basename", async () => {
		captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		child.stderr.write("cannot resolve /Users/secret/private-repo/notes.md\n");
		await flush();
		child.close(1);

		expect(await message).toContain("cannot resolve notes.md");
		expect(await message).not.toContain("secret");
	});

	// `claude` is a Node ESM program, so this is the likeliest absolute path in the
	// whole stream: both the resolver's message and every stack frame spell the
	// entry point as a file:// URL.
	it("redacts a file:// URL in a module-resolution failure and its stack frame", async () => {
		captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		child.stderr.write(
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x' imported from file:///Users/secret/app/index.mjs\n",
		);
		child.stderr.write("    at file:///Users/secret/app/index.mjs:3:1\n");
		await flush();
		child.close(1);

		expect(await message).toContain("Cannot find package 'x' imported from index.mjs");
		expect(await message).toContain("at index.mjs:3:1");
		expect(await message).not.toContain("secret");
	});

	it("drops a line that redaction empties rather than logging a blank", async () => {
		captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const message = run.then(
			() => "",
			(err: Error) => err.message,
		);
		child.emit("spawn");
		child.stderr.write("//\n");
		await flush();
		child.close(1);

		expect(await message).toBe("agent exited with code 1");
	});

	it("redacts after truncating, so a path-shaped megabyte stays cheap", async () => {
		captureLog();
		const child = new FakeChild();
		const run = makeSession(child).run();
		const failure = expect(run).rejects.toThrow();
		child.emit("spawn");

		// Redaction runs on the 800-character slice, so its real cost is a fraction
		// of a millisecond. Redacting the raw line first costs ~140 ms on this input
		// — measured — so the threshold has to sit well under that to actually pin
		// the ordering; wall clock is the only signal, since capping to 200
		// characters makes both orders produce identical text.
		const started = performance.now();
		child.stderr.write(`${`${JOB.repoRoot}/a `.repeat(200_000)}\n`);
		await flush();
		expect(performance.now() - started).toBeLessThan(20);

		child.close(1);
		await failure;
	});
});
