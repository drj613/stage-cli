import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobProgress } from "@stagereview/types/generation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/client.js";
import { chapter, chapterRun } from "../db/schema/index.js";
import { type GenerationDeps, runGenerationJob } from "../generation/claude-runner.js";
import type { JobRequest } from "../generation/job-manager.js";
import { type ResolvedFilteredDiff, resolveFilteredDiff } from "../resolve-diff.js";
import { listRunMembers } from "../runs/run-members.js";
import { FakeChild } from "./fake-child-process.js";
import { initTempRepo, removeTempRepo, type TempRepo } from "./temp-repo.js";

let repo: TempRepo;
let tmpDir: string;
let dbPath: string;
let smallDiff: ResolvedFilteredDiff;
const spawned: JobRequest[] = [];
const progress: JobProgress[] = [];

function makeJob(): JobRequest {
	return {
		prUrls: ["https://github.com/acme/widgets/pull/28"],
		repoRoot: repo.dir,
		requestedModel: "sonnet",
	};
}

function makeDeps(over: Partial<GenerationDeps> = {}): GenerationDeps {
	return {
		resolveDiff: async () => smallDiff,
		spawnChild: (job) => {
			spawned.push(job);
			const child = new FakeChild();
			queueMicrotask(() => child.close(1, null));
			return child;
		},
		db: getDb({ dbPath }),
		now: () => Date.now(),
		...over,
	};
}

beforeEach(async () => {
	spawned.length = 0;
	progress.length = 0;
	repo = await initTempRepo("claude-runner");
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cli-runner-db-"));
	dbPath = path.join(tmpDir, "db.sqlite");
	closeDb();
	smallDiff = await resolveFilteredDiff({ cwd: repo.dir });
});

afterEach(async () => {
	closeDb();
	await removeTempRepo(repo);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runGenerationJob", () => {
	it("imports a synthetic run for a small diff without spawning an agent", async () => {
		const db = getDb({ dbPath });
		let resolvedFor: { cwd: string; prRefs?: string[] } | null = null;
		const deps = makeDeps({
			db,
			resolveDiff: async (options) => {
				resolvedFor = options;
				return { ...smallDiff, members: [{ prNumber: 28, headSha: smallDiff.scope.headSha }] };
			},
		});

		const runId = await runGenerationJob(makeJob(), (p) => progress.push(p), deps);

		expect(spawned).toEqual([]);
		expect(resolvedFor).toEqual({
			cwd: repo.dir,
			prRefs: ["https://github.com/acme/widgets/pull/28"],
		});
		const runs = db.select().from(chapterRun).all();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.id).toBe(runId);
		// The run must record the clone, not the daemon's working directory, or every
		// later diff route reads the wrong repo.
		expect(runs[0]?.repoRoot).toBe(repo.dir);
		// The synthetic path inserts membership too — a run that skipped the agent
		// still has to resolve back to its PR from the dashboard.
		expect(listRunMembers(db, runId)).toEqual([
			{ prNumber: 28, headSha: smallDiff.scope.headSha, position: 0 },
		]);
		expect(
			db
				.select()
				.from(chapter)
				.all()
				.map((row) => row.title),
		).toEqual(["All changes", "Other changes"]);
	});

	it("reports progress the dashboard can render, leaving the end stamp to the manager", async () => {
		await runGenerationJob(makeJob(), (p) => progress.push(p), makeDeps());

		expect(progress.length).toBeGreaterThan(0);
		const last = progress.at(-1);
		expect(last?.endedAt).toBeNull();
		expect(last?.resolvedModel).toBeNull();
		expect(last?.turns).toBe(0);
		expect(last?.activity).toHaveLength(1);
		expect(last?.activity[0]?.state).toBe("done");
	});

	it("gives a lockfile-only PR one other-changes chapter and no agent", async () => {
		const db = getDb({ dbPath });
		const lockfileOnly: ResolvedFilteredDiff = {
			...smallDiff,
			files: [],
			excludedByPath: ["pnpm-lock.yaml"],
			stats: { filteredFileCount: 0, filteredHunkCount: 0, changedLines: 0 },
		};

		await runGenerationJob(
			makeJob(),
			(p) => progress.push(p),
			makeDeps({ db, resolveDiff: async () => lockfileOnly }),
		);

		expect(spawned).toEqual([]);
		expect(
			db
				.select()
				.from(chapter)
				.all()
				.map((row) => row.title),
		).toEqual(["Other changes"]);
	});

	it("spawns the agent when the diff is too large to review directly", async () => {
		const largeDiff: ResolvedFilteredDiff = {
			...smallDiff,
			stats: { filteredFileCount: 9, filteredHunkCount: 30, changedLines: 800 },
		};

		await expect(
			runGenerationJob(
				makeJob(),
				(p) => progress.push(p),
				makeDeps({ resolveDiff: async () => largeDiff }),
			),
		).rejects.toThrow();

		expect(spawned.map((job) => job.repoRoot)).toEqual([repo.dir]);
	});

	it("fails the job when the diff cannot be resolved", async () => {
		const deps = makeDeps({
			resolveDiff: async () => {
				throw new Error("gh pr view failed");
			},
		});

		await expect(runGenerationJob(makeJob(), (p) => progress.push(p), deps)).rejects.toThrow(
			"gh pr view failed",
		);
	});
});
