import type { JobProgress } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { JobManager } from "../generation/job-manager.js";

const REPO_ROOT = "/Users/secret/private-repo";

function makeProgress(overrides: Partial<JobProgress> = {}): JobProgress {
	return {
		startedAt: 1,
		endedAt: null,
		resolvedModel: "claude-sonnet-5",
		turns: 3,
		phase: "analyze",
		activity: [{ tool: "Read", target: "src/a.ts", state: "done" }],
		...overrides,
	};
}

/** A manager whose runner hands its `onProgress` back and blocks until released. */
function blockedManager() {
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
		prUrls: ["https://github.com/o/r/pull/1"],
		repoRoot: REPO_ROOT,
		requestedModel: "sonnet",
	});
	return {
		manager,
		id,
		push: (progress: JobProgress) => push(progress),
		release: () => release(),
	};
}

describe("JobManager progress", () => {
	it("exposes the latest snapshot and lists only non-terminal jobs", async () => {
		const { manager, id, push, release } = blockedManager();
		await new Promise((r) => setTimeout(r, 0));

		const progress = makeProgress();
		push(progress);
		expect(manager.get(id)?.progress).toEqual(progress);
		expect(manager.get(id)?.requestedModel).toBe("sonnet");
		expect(manager.activeJobs().map((job) => job.id)).toEqual([id]);

		release();
		await manager.settled();
		expect(manager.activeJobs()).toEqual([]);
	});

	it("keeps repoRoot out of the jobs it lists", async () => {
		const { manager, push, release } = blockedManager();
		await new Promise((r) => setTimeout(r, 0));
		push(makeProgress());

		const listed = manager.activeJobs();
		expect(listed).toHaveLength(1);
		expect(listed[0] && "repoRoot" in listed[0]).toBe(false);
		expect(JSON.stringify(listed)).not.toContain("secret");

		release();
		await manager.settled();
	});

	it("hands out progress a caller cannot mutate", async () => {
		const { manager, id, push, release } = blockedManager();
		await new Promise((r) => setTimeout(r, 0));
		push(makeProgress());

		// A mutable snapshot lets a caller write a value the wire schema rejects,
		// after which every poll for this job 500s.
		const leaked = manager.get(id)?.progress;
		if (leaked) leaked.turns = -5;
		const entry = leaked?.activity[0];
		if (entry) entry.tool = "";
		expect(manager.get(id)?.progress?.turns).toBe(3);
		expect(manager.get(id)?.progress?.activity[0]?.tool).toBe("Read");

		release();
		await manager.settled();
	});
});
