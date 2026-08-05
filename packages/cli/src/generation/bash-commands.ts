import path from "node:path";

export interface CommandInvocation {
	readonly program: string;
	readonly args: readonly string[];
}

/** `<< 'DELIM'`, `<<-DELIM`, `<< "DELIM"` — captures the delimiter word. */
const HEREDOC_OPENER = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
/** Anything that ends one command and starts another. `$(` opens a subshell. */
const SEGMENT_SEPARATOR = /\$\(|[;\n|&`()]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Redirections belong to the command but are not its program or its arguments. */
const REDIRECTION = /^[0-9]*[<>]/;

/**
 * Drops heredoc bodies. Chapter JSON is written through a heredoc, and its
 * contents must never be mistaken for commands the agent ran.
 */
function stripHeredocBodies(command: string): string {
	const kept: string[] = [];
	let delimiter: string | null = null;
	for (const line of command.split("\n")) {
		if (delimiter !== null) {
			if (line.trim() === delimiter) delimiter = null;
			continue;
		}
		kept.push(line);
		const opener = HEREDOC_OPENER.exec(line);
		if (opener) delimiter = opener[2] ?? null;
	}
	return kept.join("\n");
}

/**
 * Every program the command invokes in command position, with its arguments.
 *
 * This is a narrow recognizer for the shapes the stage-chapters skill emits —
 * assignment-wrapped command substitution, pipelines, and `&&` chains — not a
 * shell parser. A real parser is out of scope, and a dependency for two
 * commands is not worth the weight.
 */
export function commandInvocations(command: string): CommandInvocation[] {
	const invocations: CommandInvocation[] = [];
	for (const segment of stripHeredocBodies(command).split(SEGMENT_SEPARATOR)) {
		const words = segment.split(/\s+/).filter((word) => word !== "");
		const start = words.findIndex((word) => !ASSIGNMENT.test(word) && !REDIRECTION.test(word));
		if (start === -1) continue;
		const program = words[start];
		if (program === undefined) continue;
		invocations.push({ program: path.basename(program), args: words.slice(start + 1) });
	}
	return invocations;
}

/** Just the program names — the allowlist check does not care about arguments. */
export function commandPrograms(command: string): string[] {
	return commandInvocations(command).map((invocation) => invocation.program);
}

/** Whether the command runs `<program> <subcommand>` in command position. */
export function invokesSubcommand(command: string, program: string, subcommand: string): boolean {
	return commandInvocations(command).some(
		(invocation) => invocation.program === program && invocation.args[0] === subcommand,
	);
}
