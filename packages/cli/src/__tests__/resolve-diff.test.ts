import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFilteredDiff } from "../resolve-diff.js";
import { initTempRepo, removeTempRepo, type TempRepo } from "./temp-repo.js";

let repo: TempRepo;

beforeEach(async () => {
	repo = await initTempRepo("resolve-diff");
});

afterEach(() => removeTempRepo(repo));

describe("resolveFilteredDiff", () => {
	it("splits the diff into reviewable files and the ones excluded by path", async () => {
		const result = await resolveFilteredDiff({ cwd: repo.dir });

		expect(result.files.map((file) => file.path)).toEqual(["other.md", "src.ts"]);
		expect(result.excludedByPath).toEqual(["pnpm-lock.yaml"]);
		expect(result.allFiles.map((file) => file.path)).toContain("pnpm-lock.yaml");
	});

	it("counts hunks, files, and changed lines over the reviewable files only", async () => {
		const result = await resolveFilteredDiff({ cwd: repo.dir });

		expect(result.stats).toEqual({
			filteredFileCount: 2,
			filteredHunkCount: 2,
			changedLines: 4,
		});
	});

	it("carries the scope and merge base the diff was taken against", async () => {
		const result = await resolveFilteredDiff({ cwd: repo.dir });

		expect(result.scope.headSha).toBe(repo.headSha);
		expect(result.mergeBaseSha).toBe(repo.baseSha);
		expect(result.members).toEqual([]);
	});

	it("drops files matched by the resolved repo's .stageignore", async () => {
		const ignoring = await initTempRepo("resolve-diff-ignore", { ".stageignore": "other.md\n" });

		const result = await resolveFilteredDiff({ cwd: ignoring.dir });
		await removeTempRepo(ignoring);

		expect(result.files.map((file) => file.path)).toEqual(["src.ts"]);
		expect(result.excludedByPath).toEqual(["other.md", "pnpm-lock.yaml"]);
	});
});
