import { describe, expect, it } from "vitest";
import { sanitizeText } from "../generation/describe-tool-use.js";

describe("sanitizeText", () => {
	it("strips ANSI colour sequences", () => {
		expect(sanitizeText("\u001B[31mred\u001B[0m text")).toBe("red text");
	});

	it("strips a clear-screen and cursor-home sequence", () => {
		expect(sanitizeText("\u001B[2J\u001B[Hcleared")).toBe("cleared");
	});

	it("strips an OSC sequence terminated by BEL", () => {
		expect(sanitizeText("\u001B]0;title\u0007done")).toBe("done");
	});

	it("leaves nothing behind for a truncated escape sequence", () => {
		expect(sanitizeText("git log \u001B[")).toBe("git log");
	});

	it("replaces bare control characters with spaces and collapses runs", () => {
		expect(sanitizeText("a b\tc")).toBe("a b c");
	});

	it("replaces a C1 control character with a space", () => {
		expect(sanitizeText("a\u009B31mred")).toBe("a 31mred");
	});

	it("replaces backspaces so displayed text cannot be overwritten", () => {
		expect(sanitizeText("safe.ts\b\b\bexe")).toBe("safe.ts exe");
	});

	it("strips bidi controls that would reverse how text reads", () => {
		expect(sanitizeText("git log \u202Etxt.exe")).toBe("git log txt.exe");
	});

	it("strips zero-width, soft-hyphen, invisible-maths and tag characters", () => {
		expect(sanitizeText("a\u200Bb\u200Cc\u200Dd\u00ADe\u180Ef\u2062g\u{E0041}h")).toBe("abcdefgh");
	});

	it("strips blank-rendering Hangul and halfwidth fillers", () => {
		expect(sanitizeText("a\u3164b\u115Fc\u1160d\uFFA0e")).toBe("abcde");
	});

	it("bounds the combining marks stacked onto one character", () => {
		expect(sanitizeText(`a${"\u0350".repeat(59)}b`)).toBe(`a${"\u0350".repeat(3)}b`);
	});
});
