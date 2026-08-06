import { DETAIL_LIMIT } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { parseStreamEvent, toolResultDetail } from "../generation/stream-events.js";

const REPO_ROOT = "/Users/dev/clone";

function textBlocks(...texts: string[]): unknown[] {
	return texts.map((text) => ({ type: "text", text }));
}

describe("toolResultDetail", () => {
	it("keeps the first line of a string content", () => {
		expect(toolResultDetail("no such option: --pr\nusage: stagereview", REPO_ROOT)).toBe(
			"no such option: --pr",
		);
	});

	it("reads the text of an array content", () => {
		expect(toolResultDetail(textBlocks("exit code 2"), REPO_ROOT)).toBe("exit code 2");
	});

	it("skips array parts that are not text blocks", () => {
		const content = [{ type: "image", source: {} }, 5, null, ...textBlocks("the real reason")];
		expect(toolResultDetail(content, REPO_ROOT)).toBe("the real reason");
	});

	it("skips leading blank lines", () => {
		expect(toolResultDetail("\n\n  \nboom", REPO_ROOT)).toBe("boom");
	});

	it("returns undefined for content carrying no text", () => {
		for (const content of [undefined, null, 5, "", "   ", {}, [], [{ type: "image" }]]) {
			expect(toolResultDetail(content, REPO_ROOT)).toBeUndefined();
		}
	});

	it("rewrites an absolute path inside the clone to a repo-relative one", () => {
		expect(toolResultDetail(`error in ${REPO_ROOT}/src/a.ts`, REPO_ROOT)).toBe("error in src/a.ts");
	});

	it("reduces a path outside the clone to its basename", () => {
		expect(toolResultDetail("cannot read /Users/dev/.ssh/id_rsa", REPO_ROOT)).toBe(
			"cannot read id_rsa",
		);
	});

	it("strips ANSI escapes and control characters", () => {
		expect(toolResultDetail("\u001b[31mFAIL\u001b[0m\u0007 here", REPO_ROOT)).toBe("FAIL here");
	});

	// 2 MB, not the 10 MB a tool can really print: allocating that much in one
	// worker slows the wall-clock assertions in another one enough to fail them.
	// Sanitizing even this much before trimming costs seconds, so it still fails
	// loudly if the order is ever reversed.
	it("bounds the detail however large the payload", () => {
		const huge = "x".repeat(2_000_000);
		const started = performance.now();
		const detail = toolResultDetail(huge, REPO_ROOT);
		const arrayDetail = toolResultDetail(textBlocks(huge, huge, huge), REPO_ROOT);
		expect(performance.now() - started).toBeLessThan(200);
		expect(detail?.length).toBeLessThanOrEqual(DETAIL_LIMIT);
		expect(arrayDetail?.length).toBeLessThanOrEqual(DETAIL_LIMIT);
	});
});

describe("tool_result content parsing", () => {
	function parseWithContent(content: unknown): string {
		return parseStreamEvent({
			type: "user",
			message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content }] },
		}).outcome;
	}

	it("accepts every content shape rather than dropping the line", () => {
		for (const content of [undefined, null, 5, "text", [], textBlocks("a"), { nested: true }]) {
			expect(parseWithContent(content)).toBe("event");
		}
	});
});
