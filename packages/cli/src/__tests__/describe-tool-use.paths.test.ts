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

	it("leaves a command with no absolute path untouched", () => {
		expect(describeToolUse("Bash", { command: "git log --oneline -n 5" }, REPO_ROOT).target).toBe(
			"git log --oneline -n 5",
		);
	});
});
