import { describe, expect, it } from "vitest";
import { JobManager, MAX_RETAINED_PRS } from "../generation/job-manager.js";

const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`;

function enqueue(manager: JobManager, n: number): string {
	return manager.enqueue({ prUrl: prUrl(n), repoRoot: "/o", requestedModel: "sonnet" });
}

describe("JobManager retention", () => {
	it("keeps only the newest terminal job for a PR", async () => {
		const manager = new JobManager(async () => "run-1");
		const first = enqueue(manager, 1);
		await manager.settled();
		const second = enqueue(manager, 1);
		await manager.settled();

		expect(manager.get(first)).toBeNull();
		expect(manager.get(second)?.status).toBe("succeeded");
		expect(manager.latestJobFor(prUrl(1))?.id).toBe(second);
	});

	it("evicts the least recently finished PR once the cap is exceeded", async () => {
		const manager = new JobManager(async () => "run-1");
		const ids: string[] = [];
		for (let n = 1; n <= MAX_RETAINED_PRS + 1; n += 1) ids.push(enqueue(manager, n));
		await manager.settled();

		expect(manager.get(ids[0] ?? "")).toBeNull();
		expect(manager.get(ids[1] ?? "")?.status).toBe("succeeded");
		expect(manager.get(ids[MAX_RETAINED_PRS] ?? "")?.status).toBe("succeeded");
	});

	it("never evicts a job that has not finished", async () => {
		const manager: JobManager = new JobManager(async () => {
			// Every pass but the first runs after an eviction. The job being run is
			// non-terminal, so it must always still be listed.
			observed.push(manager.activeJobs().length);
			return "run-1";
		});
		const observed: number[] = [];
		for (let n = 1; n <= MAX_RETAINED_PRS + 1; n += 1) enqueue(manager, n);
		await manager.settled();

		expect(observed).toHaveLength(MAX_RETAINED_PRS + 1);
		expect(observed.every((count) => count >= 1)).toBe(true);
		expect(observed.at(-1)).toBe(1); // the last job, running, with everything else terminal
	});
});
