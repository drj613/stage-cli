import { describe, expect, it } from "vitest";
import { JobManager } from "../generation/job-manager.js";

describe("JobManager", () => {
	it("runs jobs sequentially", async () => {
		const order: string[] = [];
		const manager = new JobManager(async (job) => {
			order.push(`start:${job.prUrl}`);
			await new Promise((r) => setTimeout(r, 10));
			order.push(`end:${job.prUrl}`);
			return "run-1";
		});
		const a = manager.enqueue({
			prUrl: "https://github.com/a/a/pull/1",
			repoRoot: "/a",
			model: "sonnet",
		});
		const b = manager.enqueue({
			prUrl: "https://github.com/b/b/pull/2",
			repoRoot: "/b",
			model: "sonnet",
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

	it("records failures without stopping the queue", async () => {
		const manager = new JobManager(async (job) => {
			if (job.prUrl.includes("bad")) throw new Error("boom");
			return "run-2";
		});
		const bad = manager.enqueue({
			prUrl: "https://github.com/x/x/pull/9?bad",
			repoRoot: "/x",
			model: "sonnet",
		});
		const good = manager.enqueue({
			prUrl: "https://github.com/y/y/pull/3",
			repoRoot: "/y",
			model: "sonnet",
		});
		await manager.settled();
		expect(manager.get(bad)?.status).toBe("failed");
		expect(manager.get(bad)?.error).toBe("boom");
		expect(manager.get(good)?.status).toBe("succeeded");
	});
});
