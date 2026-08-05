import path from "node:path";

export interface CommandInvocation {
	readonly program: string;
	readonly args: readonly string[];
}

/**
 * One shell token: a quoted span, an escaped character, a subshell opener, a
 * comment, a separator, a bare word, or blanks. Quoted spans and comments come
 * before bare words so they win; a `#` inside a word is swallowed by the word.
 * The trailing quote alternatives run to the end of the input, so an unterminated
 * quote hides what follows it instead of exposing it as commands.
 */
const TOKEN =
	/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|\$\(|#[^\n]*|[;\n|&`()]|[^\s;\n|&`()'"\\]+|[^\S\n]+|'[^']*|"(?:\\[\s\S]|[^"\\])*/g;
const SEPARATORS = new Set([";", "\n", "|", "&", "`", "(", ")", "$("]);
/**
 * A heredoc opener at the start of a token, optionally after a redirection such
 * as the `>out` of `>out<<EOF`. Never `<<<` (a herestring) and never the `<<` of
 * an arithmetic shift, both of which would yield an invented delimiter.
 */
const HEREDOC_OPENER = /^(?:[0-9]*[<>]\S+?)?<<(?!<)-?/;
/** An inline delimiter ends where the next operator begins: `<<EOF>out`. */
const DELIMITER_TAIL = /[<>;|&][\s\S]*$/;
const LINE_CONTINUATION = /^\\\n$/;
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

function stripQuotes(token: string, quote: string): string {
	const body = token.slice(1);
	return body.endsWith(quote) ? body.slice(0, -1) : body;
}

function unquote(token: string): string {
	if (token.startsWith("'")) return stripQuotes(token, "'");
	if (token.startsWith('"')) return stripQuotes(token, '"').replace(/\\([\s\S])/g, "$1");
	if (token.startsWith("\\")) return token.slice(1);
	return token;
}

/** The first whole word the tokens spell out, joining tokens that touch. */
function firstWord(tokens: string[]): string | undefined {
	let word: string | undefined;
	for (const token of tokens) {
		if (SEPARATORS.has(token)) break;
		if (token.trim() === "") {
			if (word !== undefined) break;
			continue;
		}
		word = (word ?? "") + unquote(token);
	}
	return word === "" ? undefined : word;
}

/**
 * The delimiter word a heredoc on this line opens, taken whole so it is either
 * recognized in full or not at all. A truncated or invented delimiter would never
 * match its terminator line, and every following line would be dropped as heredoc
 * body — hiding real commands. Missing a real heredoc only costs phantom programs,
 * so this stays conservative and returns nothing unless the shape is clearly a
 * heredoc opener.
 */
function heredocDelimiter(line: string): string | undefined {
	const tokens = rawTokens(line);
	for (const [index, token] of tokens.entries()) {
		if (isQuoted(token) || token.startsWith("\\") || token.startsWith("#")) continue;
		const opener = HEREDOC_OPENER.exec(token);
		if (opener === null) continue;
		const inline = token.slice(opener[0].length).replace(DELIMITER_TAIL, "");
		return inline === "" ? firstWord(tokens.slice(index + 1)) : inline;
	}
	return undefined;
}

interface HeredocScan {
	/** The command with every heredoc body removed. */
	readonly commands: string;
	/** The delimiter of the first heredoc each line opens, in order. */
	readonly delimiters: string[];
}

/**
 * Separates the commands from the heredoc bodies they carry. Chapter JSON is
 * written through a heredoc, and its contents must never be mistaken for commands
 * the agent ran — nor may an opener inside a body count as one.
 *
 * Terminator lines are matched trimmed for every heredoc, where bash only strips
 * leading whitespace for `<<-`. That errs toward ending the body early, which at
 * worst adds phantom programs.
 */
function scanHeredocs(command: string): HeredocScan {
	const kept: string[] = [];
	const delimiters: string[] = [];
	let delimiter: string | undefined;
	for (const line of command.replace(/\r\n/g, "\n").split("\n")) {
		if (delimiter !== undefined) {
			if (line.trim() === delimiter) delimiter = undefined;
			continue;
		}
		kept.push(line);
		delimiter = heredocDelimiter(line);
		if (delimiter !== undefined) delimiters.push(delimiter);
	}
	return { commands: kept.join("\n"), delimiters };
}

/**
 * The delimiter of the first heredoc each line of the command opens.
 *
 * A mention of an opener is not an opener: `rg "<< 'AGENT_EOF'"` searches for that
 * text, and `# see <<EOF` is a comment. Callers that key off a specific delimiter
 * — the chapter JSON is written through `<< 'AGENT_EOF'` — need that distinction,
 * which a substring match on the raw command cannot make.
 *
 * Only the first opener on a line is reported, so `cat <<'A'; cat <<'B'` yields
 * just `A`. Bash queues both bodies, and reading them apart means tracking a stack
 * of pending delimiters — the same conservatism as `heredocDelimiter`: under-report
 * rather than invent a delimiter that would swallow every following line.
 */
export function heredocDelimiters(command: string): string[] {
	return scanHeredocs(command).delimiters;
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
 * is reported as the program: wrappers (`sudo`, `env`, `timeout`, `bash -c`, `!`,
 * `time`, brace groups) and shell keywords (`if`, `then`) hide the program they run.
 */
export function commandInvocations(command: string): CommandInvocation[] {
	const invocations: CommandInvocation[] = [];
	for (const words of splitSegments(scanHeredocs(command).commands)) {
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
