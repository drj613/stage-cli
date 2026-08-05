import { describe, expect, it } from "vitest";
import { commandInvocations, commandPrograms } from "../generation/bash-commands.js";

describe("commandInvocations", () => {
	it("sees through assignment-wrapped command substitution", () => {
		// Verbatim from skills/stage-chapters/SKILL.md step 1.
		expect(commandInvocations("PREP_FILE=$(stagereview prep)")).toEqual([
			{ program: "stagereview", args: ["prep"] },
		]);
	});

	it("keeps flags as args", () => {
		expect(commandInvocations("PREP_FILE=$(stagereview prep --pr 123)")).toEqual([
			{ program: "stagereview", args: ["prep", "--pr", "123"] },
		]);
	});

	it("handles the multiline mktemp + heredoc block from step 5", () => {
		const command = [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
			'AGENT_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/stage-agent-output.XXXXXX")',
			`cat > "$AGENT_OUTPUT" << 'AGENT_EOF'`,
			'{ "chapters": [] }',
			"AGENT_EOF",
		].join("\n");
		expect(commandPrograms(command)).toEqual(["mktemp", "cat"]);
	});

	it("ignores program names inside a heredoc body", () => {
		const command = ["cat << 'EOF'", "stagereview import should not count", "EOF"].join("\n");
		expect(commandPrograms(command)).toEqual(["cat"]);
	});

	it("finds every program in a pipeline or chain", () => {
		expect(commandPrograms("git diff main | rg foo && gh pr view 1")).toEqual(["git", "rg", "gh"]);
	});

	it("skips leading environment assignments", () => {
		expect(commandInvocations("FOO=bar git push")).toEqual([{ program: "git", args: ["push"] }]);
	});

	it("reduces an absolute program path to its basename", () => {
		expect(commandPrograms("/usr/local/bin/stagereview import x")).toEqual(["stagereview"]);
	});

	it("returns nothing for an empty command", () => {
		expect(commandPrograms("   ")).toEqual([]);
	});
});
