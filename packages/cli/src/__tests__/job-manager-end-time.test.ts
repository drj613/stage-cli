import { type JobProgress, JobProgressSchema } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { JobManager } from "../generation/job-manager.js";

const REPO_ROOT = "/Users/secret/private-repo";
const STARTED_AT = Date.now() - 90_000;

function makeProgress(): JobProgress {
	return {
		startedAt: STARTED_AT,
		endedAt: null,
		resolvedModel: "claude-sonnet-5",
		turns: 3,
		phase: "write",
		activity: [],
	};
}

/**
 * A manager whose runner reports one snapshot and then settles the way `outcome`
 * says, mirroring what AgentSession does on each of its terminal paths.
 */
async function runOnce(outcome: { fail?: string; reportProgress?: boolean }) {
	const manager = new JobManager(async (_job, onProgress) => {
		if (outcome.reportProgress !== false) onProgress(makeProgress());
		if (outcome.fail !== undefined) throw new Error(outcome.fail);
		return "run-1";
	});
	const id = manager.enqueue({
		prUrl: "https://github.com/o/r/pull/1",
		repoRoot: REPO_ROOT,
		requestedModel: "sonnet",
	});
	await manager.settled();
	return manager.get(id);
}

describe("JobManager end time", () => {
	it("stamps endedAt when the runner succeeds", async () => {
		const job = await runOnce({});

		expect(job?.status).toBe("succeeded");
		const endedAt = job?.progress?.endedAt;
		expect(endedAt).toBeGreaterThanOrEqual(STARTED_AT);
		expect(Number.isInteger(endedAt)).toBe(true);
	});

	it("stamps endedAt when the runner fails, so a failed card can still show a duration", async () => {
		const job = await runOnce({ fail: "agent exited with code 1" });

		expect(job?.status).toBe("failed");
		expect(job?.progress?.endedAt).toBeGreaterThanOrEqual(STARTED_AT);
	});

	it("keeps the stamped snapshot valid on the wire", async () => {
		const job = await runOnce({ fail: "agent timed out after 900000ms" });

		expect(() => JobProgressSchema.parse(job?.progress)).not.toThrow();
	});

	it("leaves progress null for a job whose process never reported", async () => {
		const job = await runOnce({ fail: "spawn claude ENOENT", reportProgress: false });

		expect(job?.progress).toBeNull();
	});
});
