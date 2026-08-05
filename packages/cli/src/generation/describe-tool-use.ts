import path from "node:path";
import { z } from "zod";
import { commandPrograms } from "./bash-commands.js";

/**
 * Programs whose command line is safe to show verbatim. Anything else renders
 * as a bare label: the agent's vocabulary in this workflow is small and known,
 * and an unexpected command is not worth surfacing in full.
 */
const ALLOWED_BASH_PROGRAMS: ReadonlySet<string> = new Set([
	"stagereview",
	"git",
	"gh",
	"mktemp",
	"cat",
	"which",
	"rg",
]);
const OPAQUE_COMMAND = "Shell command";
const BASH_LIMIT = 80;
const PATH_LIMIT = 80;
const PATTERN_LIMIT = 60;
const TOOL_LIMIT = 40;
const ELLIPSIS = "…";
/** Enough for a base letter with a vowel sign and a tone mark; far short of a tower. */
const MAX_COMBINING_MARKS = 3;

const ESCAPE = 0x1b;
const BELL = 0x07;
/** C0 and C1 controls — cursor moves, backspaces, and the bare BEL. */
const CONTROL_CHARACTERS = /\p{Cc}/gu;
/**
 * Unicode format characters: the zero-widths, the soft hyphen, invisible maths
 * operators, variation selectors, tag characters, and the bidi controls. A bidi
 * override reverses how a name reads, so `exe.evil` displays as `live.exe`.
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Letters that render as nothing, so they pass for a space in a filename. */
const BLANK_FILLERS = /[\u115F\u1160\u3164\uFFA0]/gu;
const COMBINING_MARK = /\p{M}/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clusters(text: string): string[] {
	return [...GRAPHEMES.segment(text)].map((segment) => segment.segment);
}

/** Index just past the escape sequence starting at `start`. */
function endOfEscapeSequence(text: string, start: number): number {
	const next = text.charCodeAt(start + 1);
	// CSI — ESC [ … final byte in @-~
	if (next === 0x5b) {
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			i += 1;
			if (code >= 0x40 && code <= 0x7e) break;
		}
		return i;
	}
	// OSC — ESC ] … BEL or ESC \
	if (next === 0x5d) {
		let i = start + 2;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			if (code === BELL) return i + 1;
			if (code === ESCAPE) return i + 2;
			i += 1;
		}
		return i;
	}
	return start + 2;
}

/** Drops the marks past `MAX_COMBINING_MARKS` so one cluster cannot stack arbitrarily tall. */
function flatten(cluster: string): string {
	let marks = 0;
	let out = "";
	for (const codePoint of cluster) {
		if (COMBINING_MARK.test(codePoint) && ++marks > MAX_COMBINING_MARKS) continue;
		out += codePoint;
	}
	return out;
}

/**
 * Makes agent-authored text safe to render in a terminal and in the DOM.
 *
 * Removes, in order: ANSI escape sequences (`ESC [ … ` and `ESC ] … `, plus any
 * two-character escape), Unicode format characters, and blank-rendering filler
 * letters. Replaces C0/C1 control characters with a space, bounds the combining
 * marks on any one character, then collapses whitespace runs and trims.
 *
 * What it does NOT do: strip printable characters that merely look confusing.
 * Homoglyphs stay, and so do strong right-to-left letters such as U+05D0, which
 * still reorder the neutral characters around them. Stripping real letters would
 * corrupt legitimate filenames, so that reordering is an accepted limitation.
 */
export function sanitizeText(text: string): string {
	let escaped = "";
	let i = 0;
	while (i < text.length) {
		if (text.charCodeAt(i) === ESCAPE) {
			i = endOfEscapeSequence(text, i);
			continue;
		}
		escaped += text.charAt(i);
		i += 1;
	}
	return clusters(
		escaped
			.replace(CONTROL_CHARACTERS, " ")
			.replace(FORMAT_CHARACTERS, "")
			.replace(BLANK_FILLERS, ""),
	)
		.map(flatten)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/** Counts grapheme clusters, so a cap splits only where a reader sees a boundary. */
function cap(text: string, limit: number): string {
	const graphemes = clusters(text);
	if (graphemes.length <= limit) return text;
	return `${graphemes.slice(0, limit - 1).join("")}${ELLIPSIS}`;
}

export interface ToolDescription {
	readonly tool: string;
	readonly target: string;
}

const FilePathInput = z.object({ file_path: z.string() });
const CommandInput = z.object({ command: z.string() });
const PatternInput = z.object({ pattern: z.string() });

/** Repo-relative when the file is inside the clone; basename otherwise. */
function describePath(filePath: string, repoRoot: string): string {
	const relative = path.relative(repoRoot, filePath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		return path.basename(filePath);
	}
	return relative;
}

/**
 * Only the first line survives, which matters most for the chapter-writing
 * heredoc: its body is agent-authored prose about the user's code. A comment on
 * the first line is refused for the same reason — the tokenizer ignores comments
 * when finding programs, so displaying one would show arbitrary prose in place of
 * the command that actually ran.
 */
function describeCommand(command: string): string {
	const programs = commandPrograms(command);
	if (programs.length === 0) return OPAQUE_COMMAND;
	if (!programs.every((program) => ALLOWED_BASH_PROGRAMS.has(program))) return OPAQUE_COMMAND;
	const firstLine = sanitizeText(command.split("\n")[0] ?? "");
	if (firstLine === "" || firstLine.startsWith("#")) return OPAQUE_COMMAND;
	return cap(firstLine, BASH_LIMIT);
}

/**
 * A displayable description of one tool call. Both `name` and `input` are
 * unvalidated wire data, so every shape is parsed rather than assumed; a shape we
 * don't recognize degrades to the tool name alone rather than throwing.
 *
 * The name is sanitized once, up front, and that same value both selects the
 * branch and is returned. Dispatching on the raw name would let a decorated
 * `Read` fall through to the default and lose its target.
 */
export function describeToolUse(name: string, input: unknown, repoRoot: string): ToolDescription {
	const tool = cap(sanitizeText(name), TOOL_LIMIT);
	switch (tool) {
		case "Read":
		case "Write":
		case "Edit": {
			const parsed = FilePathInput.safeParse(input);
			return {
				tool,
				target: parsed.success
					? cap(sanitizeText(describePath(parsed.data.file_path, repoRoot)), PATH_LIMIT)
					: "",
			};
		}
		case "Bash": {
			const parsed = CommandInput.safeParse(input);
			return { tool, target: parsed.success ? describeCommand(parsed.data.command) : "" };
		}
		case "Glob":
		case "Grep": {
			const parsed = PatternInput.safeParse(input);
			return {
				tool,
				target: parsed.success ? cap(sanitizeText(parsed.data.pattern), PATTERN_LIMIT) : "",
			};
		}
		default:
			return { tool, target: "" };
	}
}
