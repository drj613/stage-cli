import { describe, expect, it } from "vitest";
import { errorResultMessage, parseStreamEvent } from "../generation/stream-events.js";

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
});

describe("errorResultMessage", () => {
	it("prefers the errors array", () => {
		expect(
			errorResultMessage({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["first", "second"],
			}),
		).toBe("first; second");
	});

	it("falls back to the error string", () => {
		expect(
			errorResultMessage({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				error: "exploded",
			}),
		).toBe("exploded");
	});

	it("falls back to a phrase for a known subtype", () => {
		expect(errorResultMessage({ type: "result", subtype: "error_max_turns", is_error: true })).toBe(
			"The agent hit its turn limit.",
		);
	});

	it("falls back to the subtype itself when unrecognized", () => {
		expect(errorResultMessage({ type: "result", subtype: "error_weird", is_error: true })).toBe(
			"Agent failed: error_weird",
		);
	});
});
