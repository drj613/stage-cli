import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway git repo holding one committed change: `src.ts` edited,
 * `pnpm-lock.yaml` edited (excluded by path), and `other.md` added. Enough for
 * anything that resolves a diff scope against a real repo instead of a fixture
 * string. Commit dates are pinned so the SHAs are the same on every run.
 */
export interface TempRepo {
	dir: string;
	/** The commit the feature branch forked from. */
	baseSha: string;
	headSha: string;
}

const COMMIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
} as const;

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, ...COMMIT_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** `baseFiles` land in the base commit, so they never show up in the resolved diff. */
export async function initTempRepo(
	marker: string,
	baseFiles: Record<string, string> = {},
): Promise<TempRepo> {
	// Realpath, because git reports the resolved worktree root and macOS's temp dir
	// is a symlink — a test comparing the two would fail on the `/private` prefix alone.
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `stage-cli-${marker}-`)));
	git(dir, "init", "--initial-branch=main");
	git(dir, "config", "commit.gpgsign", "false");

	await fs.writeFile(path.join(dir, "src.ts"), "one\ntwo\nthree\n");
	await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lock: 1\n");
	for (const [name, contents] of Object.entries(baseFiles)) {
		await fs.writeFile(path.join(dir, name), contents);
	}
	git(dir, "add", ".");
	git(dir, "commit", "-m", "base");
	const baseSha = git(dir, "rev-parse", "HEAD").trim();

	git(dir, "checkout", "-b", "feature");
	await fs.writeFile(path.join(dir, "src.ts"), "one\ntwo changed\nthree\nfour\n");
	await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lock: 2\n");
	await fs.writeFile(path.join(dir, "other.md"), "# hi\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "feature change");

	return { dir, baseSha, headSha: git(dir, "rev-parse", "HEAD").trim() };
}

export function removeTempRepo(repo: TempRepo): Promise<void> {
	return fs.rm(repo.dir, { recursive: true, force: true });
}
