import { describe, expect, it } from "vitest";
import { describeToolUse, sanitizeText } from "../generation/describe-tool-use.js";

const REPO_ROOT = "/home/dev/clones/widgets";

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
