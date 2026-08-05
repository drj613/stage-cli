import path from "node:path";
import { TARGET_LIMIT, TOOL_LIMIT } from "@stagereview/types/generation";
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
/** Display budgets, in grapheme clusters. TARGET_LIMIT bounds the same text in code units. */
const BASH_LIMIT = 80;
const PATH_LIMIT = 80;
const PATTERN_LIMIT = 60;
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

/**
 * Bounds text by two budgets at once: how much a reader sees (grapheme clusters)
 * and how much the wire schema counts (UTF-16 code units, `unitLimit`). Whichever
 * runs out first ends the text.
 *
 * Both are needed. Graphemes alone let one flag emoji spend four code units, so 80
 * of them overrun a 200-unit ceiling and the boundary rejects the whole snapshot.
 * Code units alone would sever a surrogate pair. Splitting on cluster boundaries
 * and measuring each cluster's width satisfies both.
 */
function cap(text: string, limit: number, unitLimit: number): string {
	const graphemes = clusters(text);
	if (graphemes.length <= limit && text.length <= unitLimit) return text;
	// The ellipsis costs a grapheme and a code unit, so it comes out of both budgets.
	const units = unitLimit - ELLIPSIS.length;
	let kept = "";
	for (const cluster of graphemes.slice(0, limit - 1)) {
		if (kept.length + cluster.length > units) break;
		kept += cluster;
	}
	return `${kept}${ELLIPSIS}`;
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

/** Ends a path token. `:` and `,` separate the entries of a PATH list or an argument list. */
const PATH_END = String.raw`[^\s'"|;&<>(),:]`;
/**
 * A URL keeps `:` so a port and an ESM frame's `:3:1` stay attached, and is
 * matched ahead of a bare path so `https://github.com/o/r/pull/7` is consumed
 * whole rather than having its `/o/r/pull/7` reduced to `7`.
 */
const SCHEME_URL = String.raw`[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s'"|;&<>(),]*`;
/**
 * What may precede an absolute path: a separator, optionally followed by a short
 * flag the path is glued onto (`cc -I/usr/include`). Requiring one is what keeps a
 * *relative* path intact — in `src/a.ts` and `../lib/b.ts` the `/` follows a
 * name character, and rewriting from there yields `srca.ts`, a filename that reads
 * as real and never existed. A leading `.` or `~` is excluded for the same reason.
 */
const PATH_START = String.raw`(?<=(?:^|[\s'"=|;&<>(),:])(?:-{1,2}[A-Za-z][\w-]{0,15})?)`;
const REDACTABLE = new RegExp(`${SCHEME_URL}|${PATH_START}\\/${PATH_END}+`, "g");
const FILE_SCHEME = /^file:\/\//i;

/**
 * Rewrites the absolute posix paths in display text the way a file target is
 * rewritten. The agent runs `git -C <clone>`, `mktemp`, and `stagereview import
 * <tmpdir>/chapters.json` as a matter of course, so a command line quoted
 * verbatim publishes the user's home directory — and the clone root that the
 * wire type deliberately omits — straight to the browser.
 *
 * A token-level rewrite is enough because this is display text: nothing
 * downstream executes or resolves it. `AgentSession` runs the stderr it puts on
 * the wire through this too — a resolver error or stack trace names paths far more
 * often than a tool target does, and because `claude` is a Node ESM program those
 * name the entry point as a `file://` URL, handled below.
 *
 * Posix only: `C:\Users\…`, `C:/Users/…`, and UNC `\\server\share` are left
 * untouched, and on Windows `repoRoot` would not match either, so this is a no-op
 * there. The CLI's own paths are posix in every supported install, so that gap is
 * accepted rather than covered — do not read this as sanitizing arbitrary input.
 */
export function redactPaths(text: string, repoRoot: string): string {
	return text.replace(REDACTABLE, (match) => {
		if (match.startsWith("/")) return describePath(match, repoRoot);
		const filePath = match.replace(FILE_SCHEME, "");
		// A non-file scheme, or `file://host/share` — neither names a local path.
		if (filePath === match || !filePath.startsWith("/")) return match;
		return describePath(filePath, repoRoot);
	});
}

/**
 * Only the first line survives, which matters most for the chapter-writing
 * heredoc: its body is agent-authored prose about the user's code. A comment on
 * the first line is refused for the same reason — the tokenizer ignores comments
 * when finding programs, so displaying one would show arbitrary prose in place of
 * the command that actually ran.
 */
function describeCommand(command: string, repoRoot: string): string {
	const programs = commandPrograms(command);
	if (programs.length === 0) return OPAQUE_COMMAND;
	if (!programs.every((program) => ALLOWED_BASH_PROGRAMS.has(program))) return OPAQUE_COMMAND;
	const firstLine = sanitizeText(command.split("\n")[0] ?? "");
	if (firstLine === "" || firstLine.startsWith("#")) return OPAQUE_COMMAND;
	return cap(redactPaths(firstLine, repoRoot), BASH_LIMIT, TARGET_LIMIT);
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
	// A tool name is one short ASCII word, so its display budget is its code-unit
	// ceiling: 40 of either is generous, and no wide name can outgrow the boundary.
	const tool = cap(sanitizeText(name), TOOL_LIMIT, TOOL_LIMIT);
	switch (tool) {
		case "Read":
		case "Write":
		case "Edit": {
			const parsed = FilePathInput.safeParse(input);
			return {
				tool,
				target: parsed.success
					? cap(
							sanitizeText(describePath(parsed.data.file_path, repoRoot)),
							PATH_LIMIT,
							TARGET_LIMIT,
						)
					: "",
			};
		}
		case "Bash": {
			const parsed = CommandInput.safeParse(input);
			return {
				tool,
				target: parsed.success ? describeCommand(parsed.data.command, repoRoot) : "",
			};
		}
		case "Glob":
		case "Grep": {
			const parsed = PatternInput.safeParse(input);
			return {
				tool,
				target: parsed.success
					? cap(
							redactPaths(sanitizeText(parsed.data.pattern), repoRoot),
							PATTERN_LIMIT,
							TARGET_LIMIT,
						)
					: "",
			};
		}
		default:
			return { tool, target: "" };
	}
}
