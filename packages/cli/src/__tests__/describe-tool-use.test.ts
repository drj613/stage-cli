import { describe, expect, it } from "vitest";
import { describeToolUse, sanitizeText } from "../generation/describe-tool-use.js";

const REPO_ROOT = "/home/dev/clones/widgets";
/** A high or low surrogate without its partner — what a naive UTF-16 slice leaves behind. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("sanitizeText", () => {
	it("strips ANSI colour sequences", () => {
		expect(sanitizeText("\u001B[31mred\u001B[0m text")).toBe("red text");
	});

	it("strips an OSC sequence terminated by BEL", () => {
		expect(sanitizeText("\u001B]0;title\u0007done")).toBe("done");
	});

	it("replaces bare control characters with spaces and collapses runs", () => {
		expect(sanitizeText("a b\tc")).toBe("a b c");
	});

	it("leaves nothing behind for a truncated escape sequence", () => {
		expect(sanitizeText("git log \u001B[")).toBe("git log");
	});

	it("strips bidi controls that would reverse how text reads", () => {
		expect(sanitizeText("git log \u202Etxt.exe")).toBe("git log txt.exe");
	});

	it("strips zero-width, soft-hyphen, invisible-maths and tag characters", () => {
		expect(sanitizeText("a\u200Bb\u200Cc\u200Dd\u00ADe\u180Ef\u2062g\u{E0041}h")).toBe("abcdefgh");
	});
});

describe("describeToolUse", () => {
	it("relativizes a path inside the repo", () => {
		expect(describeToolUse("Read", { file_path: `${REPO_ROOT}/src/server.ts` }, REPO_ROOT)).toEqual(
			{ tool: "Read", target: "src/server.ts" },
		);
	});

	it("reduces a path outside the repo to its basename", () => {
		expect(describeToolUse("Read", { file_path: "/tmp/stage-prep-abc123" }, REPO_ROOT)).toEqual({
			tool: "Read",
			target: "stage-prep-abc123",
		});
	});

	it("shows an allowlisted command even when wrapped in command substitution", () => {
		expect(
			describeToolUse("Bash", { command: "PREP_FILE=$(stagereview prep --pr 42)" }, REPO_ROOT),
		).toEqual({ tool: "Bash", target: "PREP_FILE=$(stagereview prep --pr 42)" });
	});

	it("hides a command that invokes anything outside the allowlist", () => {
		expect(describeToolUse("Bash", { command: "curl https://example.com" }, REPO_ROOT)).toEqual({
			tool: "Bash",
			target: "Shell command",
		});
	});

	it("shows only the first line of the chapter-writing heredoc", () => {
		const command = [
			`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
			'{ "chapters": [] }',
			"AGENT_EOF",
		].join("\n");
		expect(describeToolUse("Bash", { command }, REPO_ROOT)).toEqual({
			tool: "Bash",
			target: `cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
		});
	});

	it("caps a long allowlisted command", () => {
		const command = `git log ${"a".repeat(200)}`;
		const { target } = describeToolUse("Bash", { command }, REPO_ROOT);
		expect(target.length).toBe(80);
		expect(target.endsWith("…")).toBe(true);
	});

	it("caps a search pattern", () => {
		const { target } = describeToolUse("Grep", { pattern: "x".repeat(200) }, REPO_ROOT);
		expect(target.length).toBe(60);
	});

	it("caps a long path", () => {
		const filePath = `${REPO_ROOT}/${"deep/".repeat(50)}a.ts`;
		const { target } = describeToolUse("Read", { file_path: filePath }, REPO_ROOT);
		expect(target.length).toBe(80);
		expect(target.endsWith("…")).toBe(true);
	});

	it("caps without splitting a surrogate pair", () => {
		const { target } = describeToolUse("Grep", { pattern: "\u{1F600}".repeat(100) }, REPO_ROOT);
		expect(LONE_SURROGATE.test(target)).toBe(false);
		expect(target.endsWith("…")).toBe(true);
	});

	it("gives an unknown tool no target", () => {
		expect(describeToolUse("WebFetch", { url: "https://example.com" }, REPO_ROOT)).toEqual({
			tool: "WebFetch",
			target: "",
		});
	});

	it("gives a malformed input no target rather than throwing", () => {
		expect(describeToolUse("Read", { nope: 1 }, REPO_ROOT)).toEqual({ tool: "Read", target: "" });
	});
});
