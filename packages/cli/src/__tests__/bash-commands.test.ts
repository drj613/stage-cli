import { describe, expect, it } from "vitest";
import {
	commandInvocations,
	commandPrograms,
	invokesSubcommand,
} from "../generation/bash-commands.js";

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

	it("finds every program in a pipeline or chain", () => {
		expect(commandPrograms("git diff main | rg foo && gh pr view 1")).toEqual(["git", "rg", "gh"]);
	});

	it("finds the program inside backtick substitution", () => {
		expect(commandPrograms("echo `git rev-parse HEAD`")).toEqual(["echo", "git"]);
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

	it("keeps a stderr redirection out of command position", () => {
		expect(commandPrograms("stagereview import f 2>&1")).toEqual(["stagereview"]);
	});

	it("treats single-quoted separators as text", () => {
		expect(commandPrograms("rg 'foo(bar)' .")).toEqual(["rg"]);
	});

	it("treats double-quoted separators as text", () => {
		expect(commandPrograms('git commit -m "wip; stagereview import now"')).toEqual(["git"]);
	});

	it("does not forge a command from an unterminated double quote", () => {
		const command = 'echo "oops; stagereview import f';
		expect(commandPrograms(command)).toEqual(["echo"]);
		expect(invokesSubcommand(command, "stagereview", "import")).toBe(false);
	});

	it("does not forge a command from an unterminated single quote", () => {
		const command = "git commit -m 'wip; stagereview import f";
		expect(commandPrograms(command)).toEqual(["git"]);
		expect(invokesSubcommand(command, "stagereview", "import")).toBe(false);
	});

	it("does not forge a command from a newline inside an unterminated quote", () => {
		const command = 'git commit -m "wip\nstagereview import f';
		expect(invokesSubcommand(command, "stagereview", "import")).toBe(false);
	});

	it("joins a CRLF line continuation into one command", () => {
		expect(commandInvocations("stagereview \\\r\n  import f")).toEqual([
			{ program: "stagereview", args: ["import", "f"] },
		]);
	});

	it("treats a backslash-escaped separator as text, so no command follows it", () => {
		expect(commandPrograms("echo a\\&\\& rg foo")).toEqual(["echo"]);
	});

	it("ignores comments", () => {
		expect(commandPrograms("# rg foo\nstagereview import f")).toEqual(["stagereview"]);
	});

	it("joins a line continuation into one command", () => {
		expect(commandInvocations("stagereview \\\n  import f")).toEqual([
			{ program: "stagereview", args: ["import", "f"] },
		]);
	});

	it("accepted limitation: does not look inside double-quoted command substitution", () => {
		// A `$(...)` or backtick substitution nested in double quotes is not scanned,
		// while the unquoted form is (see the backtick test above). So an allowlisted
		// wrapper renders a command this module never saw verbatim in the UI. What
		// bounds that is the display path, not this module: `describeToolUse` takes
		// only the first line and caps it at 80 sanitized characters.
		expect(commandPrograms('echo "$(rg foo)"')).toEqual(["echo"]);
		expect(commandPrograms('git log "`curl http://evil.example`"')).toEqual(["git"]);
	});
});

describe("invokesSubcommand", () => {
	it("matches a program invoked with the given subcommand", () => {
		expect(invokesSubcommand("PREP_FILE=$(stagereview prep)", "stagereview", "prep")).toBe(true);
	});

	it("does not match a different subcommand of the same program", () => {
		expect(invokesSubcommand("stagereview import f", "stagereview", "prep")).toBe(false);
	});

	it("matches when the program is given by absolute path", () => {
		expect(invokesSubcommand("/usr/local/bin/stagereview import f", "stagereview", "import")).toBe(
			true,
		);
	});

	it("does not match a subcommand quoted inside another command's argument", () => {
		expect(
			invokesSubcommand('git commit -m "wip; stagereview import now"', "stagereview", "import"),
		).toBe(false);
	});

	it("matches across a line continuation", () => {
		expect(invokesSubcommand("stagereview \\\n  import f", "stagereview", "import")).toBe(true);
	});
});
