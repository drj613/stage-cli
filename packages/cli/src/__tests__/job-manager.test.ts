import { afterEach, describe, expect, it, vi } from "vitest";
import { JobManager } from "../generation/job-manager.js";

afterEach(() => vi.restoreAllMocks());

describe("JobManager", () => {
	it("runs jobs sequentially", async () => {
		const order: string[] = [];
		const manager = new JobManager(async (job) => {
			order.push(`start:${job.prUrls[0]}`);
			await new Promise((r) => setTimeout(r, 10));
			order.push(`end:${job.prUrls[0]}`);
			return "run-1";
		});
		const a = manager.enqueue({
			prUrls: ["https://github.com/a/a/pull/1"],
			repoRoot: "/a",
			requestedModel: "sonnet",
		});
		const b = manager.enqueue({
			prUrls: ["https://github.com/b/b/pull/2"],
			repoRoot: "/b",
			requestedModel: "sonnet",
		});
		await manager.settled();
		expect(order).toEqual([
			"start:https://github.com/a/a/pull/1",
			"end:https://github.com/a/a/pull/1",
			"start:https://github.com/b/b/pull/2",
			"end:https://github.com/b/b/pull/2",
		]);
		expect(manager.get(a)?.status).toBe("succeeded");
		expect(manager.get(a)?.runId).toBe("run-1");
		expect(manager.get(b)?.status).toBe("succeeded");
	});

	it("does not reuse a stack job for a single PR that shares its tip", () => {
		const manager = new JobManager(() => new Promise<string>(() => {}));
		const tip = "https://github.com/o/r/pull/14";
		manager.enqueue({
			prUrls: ["https://github.com/o/r/pull/13", tip],
			repoRoot: "/o",
			requestedModel: "sonnet",
		});

		// The stack and the tip alone are different work: reusing one for the other
		// would drop the user into a chain they did not ask for.
		expect(manager.activeJobFor([tip])).toBeNull();
	});

	it("reuses the job covering the same members", () => {
		const manager = new JobManager(() => new Promise<string>(() => {}));
		const members = ["https://github.com/o/r/pull/13", "https://github.com/o/r/pull/14"];
		const id = manager.enqueue({ prUrls: members, repoRoot: "/o", requestedModel: "sonnet" });

		expect(manager.activeJobFor([...members])?.id).toBe(id);
	});

	it("records failures without stopping the queue", async () => {
		const manager = new JobManager(async (job) => {
			if (job.prUrls.some((url) => url.includes("bad"))) throw new Error("boom");
			return "run-2";
		});
		const bad = manager.enqueue({
			prUrls: ["https://github.com/x/x/pull/9?bad"],
			repoRoot: "/x",
			requestedModel: "sonnet",
		});
		const good = manager.enqueue({
			prUrls: ["https://github.com/y/y/pull/3"],
			repoRoot: "/y",
			requestedModel: "sonnet",
		});
		await manager.settled();
		expect(manager.get(bad)?.status).toBe("failed");
		expect(manager.get(bad)?.error).toBe("boom");
		expect(manager.get(good)?.status).toBe("succeeded");
	});

	it("reports a failure to stderr without naming the clone", async () => {
		const logged: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		const manager = new JobManager(async () => {
			throw new Error("claude exited with code 1");
		});
		manager.enqueue({
			prUrls: ["https://github.com/x/x/pull/9"],
			repoRoot: "/Users/secret/private-repo",
			requestedModel: "sonnet",
		});
		await manager.settled();

		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("https://github.com/x/x/pull/9");
		expect(logged[0]).toContain("claude exited with code 1");
		expect(logged[0]).not.toContain("secret");
	});
});

describe("JobManager queuePosition", () => {
	it("reports 1-based queue position for queued jobs and null once running or terminal", async () => {
		const releases: Array<() => void> = [];
		const manager = new JobManager(
			(job) =>
				new Promise((resolve) => {
					releases.push(() => resolve(`run-${job.prUrls[0]}`));
				}),
		);
		const first = manager.enqueue({
			prUrls: ["https://github.com/o/r/pull/1"],
			repoRoot: "/o",
			requestedModel: "sonnet",
		});
		const second = manager.enqueue({
			prUrls: ["https://github.com/o/r/pull/2"],
			repoRoot: "/o",
			requestedModel: "sonnet",
		});
		const third = manager.enqueue({
			prUrls: ["https://github.com/o/r/pull/3"],
			repoRoot: "/o",
			requestedModel: "sonnet",
		});

		expect(manager.get(first)?.queuePosition).toBeNull(); // running — drain() shifted it off the queue
		expect(manager.get(second)?.queuePosition).toBe(1);
		expect(manager.get(third)?.queuePosition).toBe(2);

		for (const release of releases.splice(0)) release();
		await new Promise((r) => setTimeout(r, 0));
		for (const release of releases.splice(0)) release();
		await new Promise((r) => setTimeout(r, 0));
		for (const release of releases.splice(0)) release();
		await manager.settled();

		expect(manager.get(second)?.queuePosition).toBeNull(); // terminal
	});
});

describe("JobManager.latestJobFor", () => {
	it("returns the most recent job for a PR regardless of status", async () => {
		const PR_URL = "https://github.com/o/r/pull/42";
		const manager = new JobManager(async () => {
			throw new Error("boom");
		});
		const failedId = manager.enqueue({
			prUrls: [PR_URL],
			repoRoot: "/o",
			requestedModel: "sonnet",
		});
		await manager.settled();

		expect(manager.activeJobFor([PR_URL])).toBeNull(); // terminal jobs stay invisible here
		expect(manager.latestJobFor([PR_URL])?.id).toBe(failedId);
		expect(manager.latestJobFor([PR_URL])?.status).toBe("failed");
		expect(manager.latestJobFor(["https://github.com/o/r/pull/999"])).toBeNull();
	});

	it("prefers the second job over the first when a PR was retried", async () => {
		const PR_URL = "https://github.com/o/r/pull/42";
		const manager = new JobManager(async () => "run-retry");
		const first = manager.enqueue({ prUrls: [PR_URL], repoRoot: "/o", requestedModel: "sonnet" });
		await manager.settled();
		const second = manager.enqueue({ prUrls: [PR_URL], repoRoot: "/o", requestedModel: "sonnet" });
		await manager.settled();

		expect(first).not.toBe(second);
		expect(manager.latestJobFor([PR_URL])?.id).toBe(second);
	});
});

describe("JobManager.activeJobFor", () => {
	it("finds a queued or running job for the same PR, ignoring URL case", async () => {
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = new JobManager(async () => {
			await blocked;
			return "run-1";
		});
		const id = manager.enqueue({
			prUrls: ["https://github.com/Acme/Widgets/pull/7"],
			repoRoot: "/a",
			requestedModel: "sonnet",
		});

		expect(manager.activeJobFor(["https://github.com/acme/widgets/pull/7"])?.id).toBe(id);
		expect(manager.activeJobFor(["https://github.com/acme/widgets/pull/8"])).toBeNull();

		release();
		await manager.settled();
		expect(manager.activeJobFor(["https://github.com/Acme/Widgets/pull/7"])).toBeNull();
	});
});
