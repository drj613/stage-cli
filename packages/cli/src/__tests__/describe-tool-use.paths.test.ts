import { describe, expect, it } from "vitest";
import { describeToolUse } from "../generation/describe-tool-use.js";

const REPO_ROOT = "/Users/dj/code/widgets";

/**
 * Every target is rendered in the browser, so no absolute path may survive one —
 * the agent routinely runs `mktemp`, `stagereview import`, and `git -C` with
 * paths that spell out the user's home directory and the clone root itself.
 */
describe("describeToolUse path redaction", () => {
	it("shows a repo file inside a command as a repo-relative path", () => {
		expect(
			describeToolUse("Bash", { command: `cat ${REPO_ROOT}/src/a.ts` }, REPO_ROOT).target,
		).toBe("cat src/a.ts");
	});

	it("reduces a path outside the repo to its basename", () => {
		expect(
			describeToolUse("Bash", { command: "cat /Users/dj/private/secret.ts" }, REPO_ROOT).target,
		).toBe("cat secret.ts");
	});

	it("redacts the clone root passed to git -C", () => {
		expect(
			describeToolUse("Bash", { command: `git -C ${REPO_ROOT} log --oneline` }, REPO_ROOT).target,
		).toBe("git -C widgets log --oneline");
	});

	it("redacts a temp directory in an import command", () => {
		expect(
			describeToolUse(
				"Bash",
				{ command: "stagereview import /var/folders/xy/T/tmp.AbC/chapters.json" },
				REPO_ROOT,
			).target,
		).toBe("stagereview import chapters.json");
	});

	it("redacts an absolute path attached to a flag", () => {
		expect(
			describeToolUse("Bash", { command: `git --git-dir=${REPO_ROOT}/.git status` }, REPO_ROOT)
				.target,
		).toBe("git --git-dir=.git status");
	});

	it("redacts an absolute Grep pattern", () => {
		expect(describeToolUse("Grep", { pattern: "/Users/dj/private/secret" }, REPO_ROOT).target).toBe(
			"secret",
		);
	});

	it("leaves a PR URL whole", () => {
		const command = "gh pr view https://github.com/acme/widgets/pull/7 --json title";
		expect(describeToolUse("Bash", { command }, REPO_ROOT).target).toBe(command);
	});

	it("redacts a path glued straight onto a short flag", () => {
		expect(
			describeToolUse("Bash", { command: "cat -I/Users/dj/private/include x.c" }, REPO_ROOT).target,
		).toBe("cat -Iinclude x.c");
	});

	it("redacts every entry of a colon-separated path list", () => {
		expect(
			describeToolUse("Bash", { command: "cat PATH=/Users/dj/private/bin:/usr/bin" }, REPO_ROOT)
				.target,
		).toBe("cat PATH=bin:bin");
	});

	it("redacts both sides of a comma-separated pair", () => {
		expect(
			describeToolUse("Bash", { command: "cat /Users/dj/a/x.ts,/Users/dj/b/y.ts" }, REPO_ROOT)
				.target,
		).toBe("cat x.ts,y.ts");
	});

	it("keeps a line and column suffix readable", () => {
		expect(
			describeToolUse("Bash", { command: `cat ${REPO_ROOT}/src/a.ts:12:3` }, REPO_ROOT).target,
		).toBe("cat src/a.ts:12:3");
	});

	it("redacts the path inside a file:// URL but leaves other schemes whole", () => {
		expect(
			describeToolUse("Grep", { pattern: "file:///Users/dj/private/index.mjs" }, REPO_ROOT).target,
		).toBe("index.mjs");
		expect(
			describeToolUse("Grep", { pattern: "https://github.com/acme/widgets/pull/7" }, REPO_ROOT)
				.target,
		).toBe("https://github.com/acme/widgets/pull/7");
	});

	// A rewritten relative path reads as a real file that does not exist, which is
	// worse than showing the original: it holds no absolute path to redact.
	it("leaves dot- and tilde-rooted paths alone", () => {
		for (const pattern of ["./src/a.ts", "../lib/b.ts", "~/notes/x.ts", "src/a.ts"]) {
			expect(describeToolUse("Grep", { pattern }, REPO_ROOT).target).toBe(pattern);
		}
	});

	it("leaves a command with no absolute path untouched", () => {
		expect(describeToolUse("Bash", { command: "git log --oneline -n 5" }, REPO_ROOT).target).toBe(
			"git log --oneline -n 5",
		);
	});
});
