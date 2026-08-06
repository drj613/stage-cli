import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommittedComparison } from "../git.js";
import { gitIsAncestor, orderMembersByAncestry } from "../github/stack-refs.js";

/**
 * The union diff is the whole point of a stack run, and it is the one part that
 * only real git can prove: three chained branches must diff as one change, and a
 * member that was never restacked must be refused rather than silently dropped
 * from the result.
 */

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

let dir = "";

function git(...args: string[]): string {
	return execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, ...COMMIT_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function commitFile(name: string, contents: string, message: string): Promise<string> {
	await fs.writeFile(path.join(dir, name), contents);
	git("add", "-A");
	git("commit", "-m", message);
	return git("rev-parse", "HEAD");
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-stack-diff-"));
	git("init", "-b", "main");
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("union diff across a real stack", () => {
	it("diffs the whole chain as one change", async () => {
		await commitFile("base.txt", "base\n", "base");
		git("checkout", "-b", "feat/a");
		const a = await commitFile("a.txt", "a\n", "add a");
		git("checkout", "-b", "feat/b");
		const b = await commitFile("b.txt", "b\n", "add b");
		git("checkout", "-b", "feat/c");
		const c = await commitFile("c.txt", "c\n", "add c");

		const members = orderMembersByAncestry(
			// Deliberately out of order — the caller's order is never trusted.
			[
				{ prNumber: 14, headSha: c },
				{ prNumber: 12, headSha: a },
				{ prNumber: 13, headSha: b },
			],
			gitIsAncestor(dir),
		);
		expect(members.map((m) => m.prNumber)).toEqual([12, 13, 14]);

		const tip = members[members.length - 1];
		if (!tip) throw new Error("no tip");
		const { rawDiff } = resolveCommittedComparison(dir, "main", tip.headSha);

		// Every member's file, in one diff — the bottom PR's work included.
		expect(rawDiff).toContain("a.txt");
		expect(rawDiff).toContain("b.txt");
		expect(rawDiff).toContain("c.txt");
		expect(rawDiff).not.toContain("base.txt");
	});

	it("refuses a stack whose lower member was never restacked", async () => {
		await commitFile("base.txt", "base\n", "base");
		git("checkout", "-b", "feat/a");
		const a = await commitFile("a.txt", "a\n", "add a");
		git("checkout", "-b", "feat/b");
		const b = await commitFile("b.txt", "b\n", "add b");
		// #12 gets a new commit that #13 never rebased onto. The union diff
		// main..b would silently omit it, which is why this must throw.
		git("checkout", "feat/a");
		const movedA = await commitFile("a.txt", "a changed\n", "amend a");
		expect(movedA).not.toBe(a);

		expect(() =>
			orderMembersByAncestry(
				[
					{ prNumber: 12, headSha: movedA },
					{ prNumber: 13, headSha: b },
				],
				gitIsAncestor(dir),
			),
		).toThrow(/not stacked on/);
	});
});
