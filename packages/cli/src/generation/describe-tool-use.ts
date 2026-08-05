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
const PATTERN_LIMIT = 60;
const ELLIPSIS = "…";

const ESCAPE = 0x1b;
const BELL = 0x07;

function isControl(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
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

/**
 * Removes ANSI escape sequences and control characters, then collapses
 * whitespace. Anything rendered into a terminal or the DOM goes through here,
 * so agent output cannot move the cursor, recolour the log, or smuggle
 * invisible characters into the UI.
 */
export function sanitizeText(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text.charCodeAt(i) === ESCAPE) {
			i = endOfEscapeSequence(text, i);
			continue;
		}
		out += isControl(text.charCodeAt(i)) ? " " : text[i];
		i += 1;
	}
	return out.replace(/\s+/g, " ").trim();
}

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}${ELLIPSIS}`;
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
 * heredoc: its body is agent-authored prose about the user's code.
 */
function describeCommand(command: string): string {
	const programs = commandPrograms(command);
	if (programs.length === 0) return OPAQUE_COMMAND;
	if (!programs.every((program) => ALLOWED_BASH_PROGRAMS.has(program))) return OPAQUE_COMMAND;
	const firstLine = sanitizeText(command.split("\n")[0] ?? "");
	return firstLine === "" ? OPAQUE_COMMAND : cap(firstLine, BASH_LIMIT);
}

/**
 * A displayable description of one tool call. `input` is unvalidated wire data,
 * so every shape is parsed rather than assumed; a shape we don't recognize
 * degrades to the tool name alone rather than throwing.
 */
export function describeToolUse(name: string, input: unknown, repoRoot: string): ToolDescription {
	switch (name) {
		case "Read":
		case "Write":
		case "Edit": {
			const parsed = FilePathInput.safeParse(input);
			return {
				tool: name,
				target: parsed.success ? sanitizeText(describePath(parsed.data.file_path, repoRoot)) : "",
			};
		}
		case "Bash": {
			const parsed = CommandInput.safeParse(input);
			return { tool: name, target: parsed.success ? describeCommand(parsed.data.command) : "" };
		}
		case "Glob":
		case "Grep": {
			const parsed = PatternInput.safeParse(input);
			return {
				tool: name,
				target: parsed.success ? cap(sanitizeText(parsed.data.pattern), PATTERN_LIMIT) : "",
			};
		}
		default:
			return { tool: name, target: "" };
	}
}
