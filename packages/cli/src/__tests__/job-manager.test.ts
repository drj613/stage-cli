import { randomUUID } from "node:crypto";
import type { JobProgress } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { JobManager, parseRunnerOutput } from "../generation/job-manager.js";

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
			requestedModel: "sonnet",
		});
		const b = manager.enqueue({
			prUrl: "https://github.com/b/b/pull/2",
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

	it("records failures without stopping the queue", async () => {
		const manager = new JobManager(async (job) => {
			if (job.prUrl.includes("bad")) throw new Error("boom");
			return "run-2";
		});
		const bad = manager.enqueue({
			prUrl: "https://github.com/x/x/pull/9?bad",
			repoRoot: "/x",
			requestedModel: "sonnet",
		});
		const good = manager.enqueue({
			prUrl: "https://github.com/y/y/pull/3",
			repoRoot: "/y",
			requestedModel: "sonnet",
		});
		await manager.settled();
		expect(manager.get(bad)?.status).toBe("failed");
		expect(manager.get(bad)?.error).toBe("boom");
		expect(manager.get(good)?.status).toBe("succeeded");
	});
});

describe("JobManager queuePosition", () => {
	it("reports 1-based queue position for queued jobs and null once running or terminal", async () => {
		const releases: Array<() => void> = [];
		const manager = new JobManager(
			(job) =>
				new Promise((resolve) => {
					releases.push(() => resolve(`run-${job.prUrl}`));
				}),
		);
		const first = manager.enqueue({
			prUrl: "https://github.com/o/r/pull/1",
			repoRoot: "/o",
			requestedModel: "sonnet",
		});
		const second = manager.enqueue({
			prUrl: "https://github.com/o/r/pull/2",
			repoRoot: "/o",
			requestedModel: "sonnet",
		});
		const third = manager.enqueue({
			prUrl: "https://github.com/o/r/pull/3",
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
		const failedId = manager.enqueue({ prUrl: PR_URL, repoRoot: "/o", requestedModel: "sonnet" });
		await manager.settled();

		expect(manager.activeJobFor(PR_URL)).toBeNull(); // terminal jobs stay invisible here
		expect(manager.latestJobFor(PR_URL)?.id).toBe(failedId);
		expect(manager.latestJobFor(PR_URL)?.status).toBe("failed");
		expect(manager.latestJobFor("https://github.com/o/r/pull/999")).toBeNull();
	});

	it("prefers the second job over the first when a PR was retried", async () => {
		const PR_URL = "https://github.com/o/r/pull/42";
		const manager = new JobManager(async () => "run-retry");
		const first = manager.enqueue({ prUrl: PR_URL, repoRoot: "/o", requestedModel: "sonnet" });
		await manager.settled();
		const second = manager.enqueue({ prUrl: PR_URL, repoRoot: "/o", requestedModel: "sonnet" });
		await manager.settled();

		expect(first).not.toBe(second);
		expect(manager.latestJobFor(PR_URL)?.id).toBe(second);
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
			prUrl: "https://github.com/Acme/Widgets/pull/7",
			repoRoot: "/a",
			requestedModel: "sonnet",
		});

		expect(manager.activeJobFor("https://github.com/acme/widgets/pull/7")?.id).toBe(id);
		expect(manager.activeJobFor("https://github.com/acme/widgets/pull/8")).toBeNull();

		release();
		await manager.settled();
		expect(manager.activeJobFor("https://github.com/Acme/Widgets/pull/7")).toBeNull();
	});
});

describe("JobManager progress", () => {
	it("exposes the latest snapshot and lists only non-terminal jobs", async () => {
		let push: (progress: JobProgress) => void = () => {};
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = new JobManager(async (_job, onProgress) => {
			push = onProgress;
			await blocked;
			return "run-1";
		});
		const id = manager.enqueue({
			prUrl: "https://github.com/o/r/pull/1",
			repoRoot: "/o",
			requestedModel: "sonnet",
		});
		await new Promise((r) => setTimeout(r, 0));

		const progress: JobProgress = {
			startedAt: 1,
			resolvedModel: "claude-sonnet-5",
			turns: 3,
			phase: "analyze",
			activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
		};
		push(progress);
		expect(manager.get(id)?.progress).toEqual(progress);
		expect(manager.get(id)?.requestedModel).toBe("sonnet");
		expect(manager.activeJobs().map((job) => job.id)).toEqual([id]);

		release();
		await manager.settled();
		expect(manager.activeJobs()).toEqual([]);
	});
});

describe("parseRunnerOutput", () => {
	it("takes the runId from the agent's last line", () => {
		const runId = randomUUID();
		expect(parseRunnerOutput(`Generated 4 chapters.\nWrote chapters.json\n${runId}\n`)).toBe(runId);
	});

	it("rejects a last line that is not a runId without echoing it", () => {
		// Under stream-json this line is the tail of the agent's prose, which can
		// quote source or file contents — it must not reach an error message.
		expect(() => parseRunnerOutput("Here is the secret token abc123.\n")).toThrow(
			"Agent did not return a valid runId.",
		);
		expect(() => parseRunnerOutput("Here is the secret token abc123.\n")).not.toThrow(/abc123/);
	});

	it("rejects a 36-character non-UUID", () => {
		expect(() => parseRunnerOutput("-".repeat(36))).toThrow(/valid runId/);
	});

	it("rejects empty output", () => {
		expect(() => parseRunnerOutput("   \n")).toThrow(/valid runId/);
	});
});
