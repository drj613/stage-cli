import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSyntheticChaptersFile } from "../build-synthetic-chapters-file.js";
import { closeDb, getDb } from "../db/client.js";
import { chapter } from "../db/schema/index.js";
import { type ResolvedFilteredDiff, resolveFilteredDiff } from "../resolve-diff.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { ChaptersFileSchema } from "../schema.js";
import { makeRepoContext } from "./fixtures.js";
import { initTempRepo, removeTempRepo, type TempRepo } from "./temp-repo.js";

let repo: TempRepo;
let tmpDir: string;
let dbPath: string;
let diff: ResolvedFilteredDiff;

beforeEach(async () => {
	repo = await initTempRepo("synthetic");
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cli-synthetic-db-"));
	dbPath = path.join(tmpDir, "db.sqlite");
	closeDb();
	diff = await resolveFilteredDiff({ cwd: repo.dir });
});

afterEach(async () => {
	closeDb();
	await removeTempRepo(repo);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function everyFilteredHunk(
	resolved: ResolvedFilteredDiff,
): { filePath: string; oldStart: number }[] {
	return resolved.files.flatMap((file) =>
		file.hunks.map((hunk) => ({ filePath: file.path, oldStart: hunk.oldStart })),
	);
}

describe("buildSyntheticChaptersFile", () => {
	it("references every filtered hunk once, and survives a round-trip through the DB", () => {
		const file = buildSyntheticChaptersFile(diff);
		const db = getDb({ dbPath });

		const { runId, chapterCount } = insertChaptersFile(db, file, makeRepoContext());

		expect(chapterCount).toBe(2);
		const rows = db.select().from(chapter).all();
		expect(rows.map((row) => row.title)).toEqual(["All changes", "Other changes"]);
		expect(rows[0]?.runId).toBe(runId);
		expect(rows[0]?.hunkRefs).toEqual(everyFilteredHunk(diff));
		expect(rows[0]?.keyChanges).toEqual([]);
		expect(rows[1]?.hunkRefs).toEqual([{ filePath: "pnpm-lock.yaml", oldStart: 1 }]);
	});

	it("produces a chapters file the ingestion schema accepts, with no prologue", () => {
		const file = buildSyntheticChaptersFile(diff);

		expect(ChaptersFileSchema.safeParse(file).success).toBe(true);
		expect(file.prologue).toBeUndefined();
		expect(file.scope).toEqual(diff.scope);
		expect(file.chapters[0]?.order).toBe(1);
		expect(file.chapters[1]?.order).toBe(2);
	});

	it("gives a diff that is entirely excluded by path only the other-changes chapter", () => {
		const lockfileOnly: ResolvedFilteredDiff = {
			...diff,
			files: [],
			excludedByPath: ["pnpm-lock.yaml"],
			stats: { filteredFileCount: 0, filteredHunkCount: 0, changedLines: 0 },
		};

		const file = buildSyntheticChaptersFile(lockfileOnly);

		expect(file.chapters).toHaveLength(1);
		expect(file.chapters[0]?.title).toBe("Other changes");
		expect(file.chapters[0]?.order).toBe(1);
	});

	it("produces no chapters at all when the diff is empty", () => {
		const empty: ResolvedFilteredDiff = {
			...diff,
			allFiles: [],
			files: [],
			excludedByPath: [],
			stats: { filteredFileCount: 0, filteredHunkCount: 0, changedLines: 0 },
		};

		expect(buildSyntheticChaptersFile(empty).chapters).toEqual([]);
	});
});
