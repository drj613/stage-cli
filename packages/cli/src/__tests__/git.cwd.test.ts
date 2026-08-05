import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveScope } from "../git.js";

interface TempRepo {
	dir: string;
	headSha: string;
}

let repoA: TempRepo;
let repoB: TempRepo;
let originalCwd: string;

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
}

async function initRepo(marker: string): Promise<TempRepo> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `stage-cli-cwd-${marker}-`));
	git(dir, "init", "--initial-branch=main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "commit.gpgsign", "false");

	await fs.writeFile(path.join(dir, "file.txt"), "common\n");
	git(dir, "add", "file.txt");
	git(dir, "commit", "-m", "common");

	git(dir, "checkout", "-b", "feature");
	await fs.writeFile(path.join(dir, "file.txt"), `common\n${marker}\n`);
	git(dir, "commit", "-am", `${marker} change`);

	return { dir, headSha: git(dir, "rev-parse", "HEAD").trim() };
}

beforeEach(async () => {
	originalCwd = process.cwd();
	repoA = await initRepo("alpha");
	repoB = await initRepo("beta");
	process.chdir(repoB.dir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await fs.rm(repoA.dir, { recursive: true, force: true });
	await fs.rm(repoB.dir, { recursive: true, force: true });
});

describe("resolveScope against an explicit working directory", () => {
	it("targets the requested repo, not the process working directory", () => {
		const result = resolveScope({ cwd: repoA.dir });

		expect(result.scope.headSha).toBe(repoA.headSha);
		expect(result.scope.headSha).not.toBe(repoB.headSha);
		expect(result.rawDiff).toContain("+alpha");
		expect(result.rawDiff).not.toContain("+beta");
	});

	it("lists untracked files from the requested repo", async () => {
		await fs.writeFile(path.join(repoA.dir, "untracked.txt"), "alpha-untracked\n");
		await fs.writeFile(path.join(repoB.dir, "untracked.txt"), "beta-untracked\n");

		const result = resolveScope({ cwd: repoA.dir });

		expect(result.rawDiff).toContain("+alpha-untracked");
		expect(result.rawDiff).not.toContain("+beta-untracked");
	});
});
