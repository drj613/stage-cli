import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPrep } from "../prep.js";
import { initTempRepo, removeTempRepo, type TempRepo } from "./temp-repo.js";

let repo: TempRepo;

beforeEach(async () => {
	repo = await initTempRepo("prep");
});

afterEach(() => removeTempRepo(repo));

describe("runPrep", () => {
	it("writes the commit messages and every reviewable hunk, and nothing excluded by path", async () => {
		const filePath = await runPrep({ cwd: repo.dir });
		const contents = readFileSync(filePath, "utf8");

		expect(contents).toContain("feature change");
		expect(contents).toContain('=== File: src.ts (modified) | filePath: "src.ts", oldStart: 1 ===');
		expect(contents).toContain(
			'=== File: other.md (added) | filePath: "other.md", oldStart: 0 ===',
		);
		expect(contents).toContain("+two changed");
		expect(contents).not.toContain("pnpm-lock.yaml");
	});
});
