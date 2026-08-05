import path from "node:path";

export interface CommandInvocation {
	readonly program: string;
	readonly args: readonly string[];
}

/**
 * One shell token: a quoted span, an escaped character, a subshell opener, a
 * comment, a separator, a bare word, or blanks. Quoted spans and comments come
 * before bare words so they win; a `#` inside a word is swallowed by the word.
 */
const TOKEN =
	/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|\$\(|#[^\n]*|[;\n|&`()]|[^\s;\n|&`()'"\\]+|[^\S\n]+/g;
const SEPARATORS = new Set([";", "\n", "|", "&", "`", "(", ")", "$("]);
/** `<<` that is neither half of a `<<<` herestring. */
const HEREDOC_OPENER = /(?<!<)<<(?!<)-?/;
const LINE_CONTINUATION = /^\\[\r\n]$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Redirections belong to the command but are not its program or its arguments. */
const REDIRECTION = /^[0-9]*[<>]/;
/** A word that a following `&` continues rather than terminates, as in `2>&1`. */
const OPEN_REDIRECTION = /^[0-9]*[<>]{1,2}$/;

function rawTokens(text: string): string[] {
	return [...text.matchAll(TOKEN)].map(([token]) => token);
}

function isQuoted(token: string): boolean {
	return token.startsWith("'") || token.startsWith('"');
}

function unquote(token: string): string {
	if (token.startsWith("'")) return token.slice(1, -1);
	if (token.startsWith('"')) return token.slice(1, -1).replace(/\\([\s\S])/g, "$1");
	if (token.startsWith("\\")) return token.slice(1);
	return token;
}

/**
 * The delimiter word a heredoc on this line opens, taken whole so it is either
 * recognized in full or not at all. A truncated delimiter would never match its
 * terminator line, and every following line would be dropped as heredoc body.
 */
function heredocDelimiter(line: string): string | undefined {
	const tokens = rawTokens(line);
	for (const [index, token] of tokens.entries()) {
		if (isQuoted(token) || token.startsWith("\\")) continue;
		const opener = HEREDOC_OPENER.exec(token);
		if (opener === null) continue;
		const inline = token.slice(opener.index + opener[0].length);
		if (inline !== "") return inline;
		const next = tokens.slice(index + 1).find((candidate) => candidate.trim() !== "");
		return next === undefined ? undefined : unquote(next);
	}
	return undefined;
}

/**
 * Drops heredoc bodies. Chapter JSON is written through a heredoc, and its
 * contents must never be mistaken for commands the agent ran.
 */
function stripHeredocBodies(command: string): string {
	const kept: string[] = [];
	let delimiter: string | undefined;
	for (const line of command.split("\n")) {
		if (delimiter !== undefined) {
			if (line.trim() === delimiter) delimiter = undefined;
			continue;
		}
		kept.push(line);
		delimiter = heredocDelimiter(line);
	}
	return kept.join("\n");
}

/** The words of each command in the text, split on separators found outside quotes. */
function splitSegments(text: string): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let word: string | null = null;

	const endWord = () => {
		if (word !== null) words.push(word);
		word = null;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	for (const token of rawTokens(text)) {
		if (token.startsWith("#") || LINE_CONTINUATION.test(token)) continue;
		if (SEPARATORS.has(token)) {
			if (token === "&" && word !== null && OPEN_REDIRECTION.test(word)) word += token;
			else endSegment();
			continue;
		}
		if (token.trim() === "") {
			endWord();
			continue;
		}
		word = (word ?? "") + unquote(token);
	}
	endSegment();
	return segments;
}

/**
 * Every program the command invokes in command position, with its arguments.
 *
 * This is a narrow recognizer for the shapes the stage-chapters skill emits —
 * assignment-wrapped command substitution, pipelines, and `&&` chains — not a
 * shell parser. A real parser is out of scope, and a dependency for two
 * commands is not worth the weight. Anything else that occupies command position
 * is reported as the program: wrappers (`sudo`, `env`, `timeout`, `bash -c`) and
 * shell keywords (`if`, `then`) hide the program they run.
 */
export function commandInvocations(command: string): CommandInvocation[] {
	const invocations: CommandInvocation[] = [];
	for (const words of splitSegments(stripHeredocBodies(command))) {
		let [program, ...args] = words;
		while (program !== undefined && (ASSIGNMENT.test(program) || REDIRECTION.test(program))) {
			[program, ...args] = args;
		}
		if (program === undefined) continue;
		invocations.push({ program: path.posix.basename(program), args });
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
