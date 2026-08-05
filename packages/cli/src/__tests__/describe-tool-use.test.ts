import { describe, expect, it } from "vitest";
import { describeToolUse } from "../generation/describe-tool-use.js";

const REPO_ROOT = "/home/dev/clones/widgets";
const FLAG = "\u{1F1FA}\u{1F1F8}";
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** What the caps are measured in: what a reader sees as one character. */
function graphemes(text: string): number {
	return [...SEGMENTER.segment(text)].length;
}

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

	it("sanitizes the tool name, which is wire data too", () => {
		expect(
			describeToolUse("\u001B[2J\u001B[31mRead", { file_path: `${REPO_ROOT}/a.ts` }, REPO_ROOT),
		).toEqual({ tool: "Read", target: "a.ts" });
	});

	it("caps a long tool name", () => {
		const { tool } = describeToolUse("R".repeat(200), { nope: 1 }, REPO_ROOT);
		expect(graphemes(tool)).toBe(40);
		expect(tool.endsWith("…")).toBe(true);
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

	it("hides a command where only some of the programs are allowlisted", () => {
		expect(
			describeToolUse("Bash", { command: "git log && curl http://evil.example" }, REPO_ROOT),
		).toEqual({ tool: "Bash", target: "Shell command" });
	});

	it("hides a command whose first line is a comment", () => {
		const command = "# the token in src/secrets.ts is hunter2\ngit status";
		expect(describeToolUse("Bash", { command }, REPO_ROOT)).toEqual({
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
		expect(graphemes(target)).toBe(80);
		expect(target.endsWith("…")).toBe(true);
	});

	it("caps a search pattern", () => {
		const { target } = describeToolUse("Grep", { pattern: "x".repeat(200) }, REPO_ROOT);
		expect(graphemes(target)).toBe(60);
		expect(target.endsWith("…")).toBe(true);
	});

	it("caps a long path", () => {
		const filePath = `${REPO_ROOT}/${"deep/".repeat(50)}a.ts`;
		const { target } = describeToolUse("Read", { file_path: filePath }, REPO_ROOT);
		expect(graphemes(target)).toBe(80);
		expect(target.endsWith("…")).toBe(true);
	});

	it("caps without splitting a flag into its regional indicators", () => {
		const { target } = describeToolUse("Grep", { pattern: FLAG.repeat(80) }, REPO_ROOT);
		expect(target).toBe(`${FLAG.repeat(59)}…`);
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
