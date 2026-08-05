import { describe, expect, it } from "vitest";
import { commandPrograms, heredocDelimiters } from "../generation/bash-commands.js";

const IMPORT_LINE = "stagereview import f";

describe("heredoc handling", () => {
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

	it("still sees the command after a hyphenated delimiter", () => {
		const command = ["cat > f <<STAGE-EOF", '{ "a": 1 }', "STAGE-EOF", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["cat", "stagereview"]);
	});

	it("still sees the command after a quoted hyphenated delimiter", () => {
		const command = ["cat > f <<'STAGE-EOF'", '{ "a": 1 }', "STAGE-EOF", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["cat", "stagereview"]);
	});

	it("supports a tab-stripping heredoc", () => {
		const command = ["cat <<-EOF", "\tstagereview import ignored", "\tEOF", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["cat", "stagereview"]);
	});

	it("does not treat a herestring as a heredoc opener", () => {
		const command = ['cat <<< "foo"', IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["cat", "stagereview"]);
	});

	it("does not treat a quoted << as a heredoc opener", () => {
		const command = ['rg "a<<b" file', IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["rg", "stagereview"]);
	});

	it("does not treat a << inside a comment as a heredoc opener", () => {
		const command = ["git status # see <<EOF", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["git", "stagereview"]);
	});

	it("cuts the delimiter at a redirection that follows it", () => {
		const command = ["cat <<EOF>out", "body", "EOF", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["cat", "stagereview"]);
	});

	it("does not read an arithmetic left shift as a heredoc opener", () => {
		const command = ["echo $((1<<2))", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["echo", "stagereview"]);
	});

	it("reads a backslash-escaped delimiter whole", () => {
		const command = ["cat <<\\EOF", "rg secret", "EOF", IMPORT_LINE].join("\n");
		expect(commandPrograms(command)).toEqual(["cat", "stagereview"]);
	});
});

describe("heredocDelimiters", () => {
	it("reports the delimiter of a quoted opener", () => {
		const command = [`cat > f << 'AGENT_EOF'`, '{ "chapters": [] }', "AGENT_EOF"].join("\n");
		expect(heredocDelimiters(command)).toEqual(["AGENT_EOF"]);
	});

	it("reports the delimiter of an unquoted opener", () => {
		expect(heredocDelimiters("cat > f <<AGENT_EOF")).toEqual(["AGENT_EOF"]);
	});

	it("reports nothing for a quoted mention of an opener", () => {
		expect(heredocDelimiters(`rg "<< 'AGENT_EOF'" src`)).toEqual([]);
		expect(heredocDelimiters(`echo "<< 'AGENT_EOF'"`)).toEqual([]);
	});

	it("reports nothing for a bare mention of a delimiter", () => {
		expect(heredocDelimiters("rg AGENT_EOF src")).toEqual([]);
	});

	it("reports one delimiter per opening line, and none from inside a body", () => {
		const command = ["cat <<'A'", "cat <<'NOT_A_HEREDOC'", "A", "cat <<'B'", "B"].join("\n");
		expect(heredocDelimiters(command)).toEqual(["A", "B"]);
	});

	it("reports only the first of two openers on one line", () => {
		expect(heredocDelimiters("cat <<'A'; cat <<'B'")).toEqual(["A"]);
		expect(heredocDelimiters("cat <<'A' <<'B'\nx\nA\ny\nB")).toEqual(["A"]);
	});

	it("reports nothing for a herestring or a commented opener", () => {
		expect(heredocDelimiters('cat <<< "foo"')).toEqual([]);
		expect(heredocDelimiters("git status # see <<EOF")).toEqual([]);
	});
});
