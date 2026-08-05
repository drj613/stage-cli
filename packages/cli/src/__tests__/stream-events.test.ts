import { describe, expect, it } from "vitest";
import type { ContentBlock, ErrorResultEvent } from "../generation/stream-events.js";
import {
	errorResultMessage,
	isToolResultBlock,
	isToolUseBlock,
	parseStreamEvent,
} from "../generation/stream-events.js";

function makeErrorResult(overrides: Partial<ErrorResultEvent> = {}): ErrorResultEvent {
	return { type: "result", subtype: "error_during_execution", is_error: true, ...overrides };
}

describe("parseStreamEvent", () => {
	it("parses an init event", () => {
		const parsed = parseStreamEvent({
			type: "system",
			subtype: "init",
			model: "claude-sonnet-5",
		});
		expect(parsed).toEqual({
			outcome: "event",
			event: { type: "system", subtype: "init", model: "claude-sonnet-5" },
		});
	});

	it("parses an assistant event with a tool_use block", () => {
		const parsed = parseStreamEvent({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }],
			},
		});
		expect(parsed.outcome).toBe("event");
	});

	it("treats an unknown event type as unknown, not invalid", () => {
		expect(parseStreamEvent({ type: "stream_event", delta: {} }).outcome).toBe("unknown");
	});

	it("treats a known event with a broken payload as invalid", () => {
		expect(parseStreamEvent({ type: "assistant", message: "nope" }).outcome).toBe("invalid");
	});

	it("rejects a success result with no result text", () => {
		expect(parseStreamEvent({ type: "result", subtype: "success", num_turns: 3 }).outcome).toBe(
			"invalid",
		);
	});

	it("accepts a success result with result text", () => {
		const parsed = parseStreamEvent({
			type: "result",
			subtype: "success",
			result: "done\nabc",
			num_turns: 3,
		});
		expect(parsed.outcome).toBe("event");
	});

	it("accepts an error result with no result field", () => {
		const parsed = parseStreamEvent({
			type: "result",
			subtype: "error_max_turns",
			is_error: true,
			num_turns: 40,
		});
		expect(parsed.outcome).toBe("event");
	});

	it("rejects an error result whose subtype claims success", () => {
		expect(parseStreamEvent({ type: "result", subtype: "success", is_error: true }).outcome).toBe(
			"invalid",
		);
	});

	it("reads a result carrying both text and an error flag as a success", () => {
		expect(
			parseStreamEvent({ type: "result", subtype: "success", result: "x", is_error: true }),
		).toEqual({
			outcome: "event",
			event: { type: "result", subtype: "success", result: "x" },
		});
	});

	it("rejects a malformed tool_use block instead of degrading it", () => {
		const cases: unknown[] = [
			{ type: "tool_use", name: "Read", input: {} },
			{ type: "tool_use", id: 5, name: "Read", input: {} },
			{ type: "tool_use", id: "t1", name: 5, input: {} },
			{ type: "tool_result" },
		];
		for (const block of cases) {
			expect(parseStreamEvent({ type: "assistant", message: { content: [block] } }).outcome).toBe(
				"invalid",
			);
		}
	});

	it("keeps content block types it does not model", () => {
		const parsed = parseStreamEvent({
			type: "assistant",
			message: { content: [{ type: "text", text: "hi" }, { type: "thinking" }] },
		});
		expect(parsed.outcome).toBe("event");
	});

	it("rejects a turn count the progress schema could not carry", () => {
		for (const num_turns of [-1, 1.5]) {
			expect(
				parseStreamEvent({ type: "result", subtype: "success", result: "x", num_turns }).outcome,
			).toBe("invalid");
		}
	});

	it("treats a broken init event as unknown, since system covers other subtypes", () => {
		expect(parseStreamEvent({ type: "system", subtype: "init", model: 5 }).outcome).toBe("unknown");
	});
});

describe("content block predicates", () => {
	function blocks(...content: unknown[]): ContentBlock[] {
		const parsed = parseStreamEvent({ type: "assistant", message: { content } });
		if (parsed.outcome !== "event" || parsed.event.type !== "assistant") {
			throw new Error("fixture did not parse as an assistant event");
		}
		return parsed.event.message.content;
	}

	it("recognizes a parsed tool_use block", () => {
		const [block] = blocks({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } });
		expect(block !== undefined && isToolUseBlock(block)).toBe(true);
		expect(block !== undefined && isToolResultBlock(block)).toBe(false);
	});

	it("recognizes a parsed tool_result block", () => {
		const [block] = blocks({ type: "tool_result", tool_use_id: "t1", is_error: true });
		expect(block !== undefined && isToolResultBlock(block)).toBe(true);
		expect(block !== undefined && isToolUseBlock(block)).toBe(false);
	});

	it("rejects blocks it does not model", () => {
		for (const block of blocks({ type: "text", text: "hi" }, { type: "thinking" })) {
			expect(isToolUseBlock(block)).toBe(false);
			expect(isToolResultBlock(block)).toBe(false);
		}
	});

	it("relies on ingress to keep a block claiming tool_use but missing its id away", () => {
		expect(
			parseStreamEvent({
				type: "assistant",
				message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
			}).outcome,
		).toBe("invalid");
	});
});

describe("errorResultMessage", () => {
	it("prefers the errors array", () => {
		expect(errorResultMessage(makeErrorResult({ errors: ["first", "second"] }))).toBe(
			"first; second",
		);
	});

	it("falls back to the error string", () => {
		expect(errorResultMessage(makeErrorResult({ error: "exploded" }))).toBe("exploded");
	});

	it("falls back to a phrase for a known subtype", () => {
		expect(errorResultMessage(makeErrorResult({ subtype: "error_max_turns" }))).toBe(
			"The agent hit its turn limit.",
		);
	});

	it("falls back to the subtype itself when unrecognized", () => {
		expect(errorResultMessage(makeErrorResult({ subtype: "error_weird" }))).toBe(
			"Agent failed: error_weird",
		);
	});

	it("strips escape sequences and newlines from agent-authored text", () => {
		expect(errorResultMessage(makeErrorResult({ error: "\u001b[31mboom\nnext" }))).toBe(
			"boom next",
		);
	});

	it("bounds the message however large the payload", () => {
		const long = "x".repeat(2_000_000);
		expect(errorResultMessage(makeErrorResult({ error: long })).length).toBeLessThanOrEqual(500);
		expect(
			errorResultMessage(makeErrorResult({ subtype: long, errors: [long, long] })).length,
		).toBeLessThanOrEqual(500);
	});
});
