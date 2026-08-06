import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDbPath } from "../db/path.js";
import { NotInGitRepoError, readRepoRoot } from "../git.js";

describe("getDbPath layout", () => {
	it("places the database at ~/.stage/db.sqlite, independent of cwd or repo root", () => {
		const p = getDbPath();
		expect(p).toBe(path.join(os.homedir(), ".stage", "db.sqlite"));
	});

	it("returns the same path regardless of the current working directory", async () => {
		const originalCwd = process.cwd();
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cli-path-"));
		try {
			process.chdir(tmpDir);
			expect(getDbPath()).toBe(path.join(os.homedir(), ".stage", "db.sqlite"));
		} finally {
			process.chdir(originalCwd);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("readRepoRoot outside a git repo", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cli-no-git-"));
		process.chdir(tmpDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("throws NotInGitRepoError instead of silently falling back to cwd", () => {
		expect(() => readRepoRoot(tmpDir)).toThrow(NotInGitRepoError);
	});
});
