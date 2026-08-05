import { ACTIVITY_LIMIT, GENERATION_PHASE, JobProgressSchema } from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { StreamReducer } from "../generation/stream-reducer.js";

const REPO_ROOT = "/repo";
const STARTED_AT = 1_700_000_000_000;

function reducer(): StreamReducer {
	return new StreamReducer(REPO_ROOT, STARTED_AT);
}

function assistantWithTools(
	tools: Array<{ id: string; name: string; input: unknown }>,
	parentToolUseId: string | null = null,
): string {
	return JSON.stringify({
		type: "assistant",
		parent_tool_use_id: parentToolUseId,
		message: { content: tools.map((tool) => ({ type: "tool_use", ...tool })) },
	});
}

function toolResult(toolUseId: string, isError: boolean): string {
	return JSON.stringify({
		type: "user",
		message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
	});
}

describe("StreamReducer", () => {
	it("starts with an empty snapshot at the given time", () => {
		expect(reducer().snapshot()).toEqual({
			startedAt: STARTED_AT,
			endedAt: null,
			resolvedModel: null,
			turns: 0,
			phase: GENERATION_PHASE.PREP,
			activity: [],
		});
	});

	it("records the resolved model from init", () => {
		const r = reducer();
		r.consumeLine(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5" }));
		expect(r.snapshot().resolvedModel).toBe("claude-sonnet-5");
	});

	it("counts one turn per assistant message, not per tool block", () => {
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
				{ id: "t2", name: "Read", input: { file_path: "/repo/b.ts" } },
			]),
		);
		expect(r.snapshot().turns).toBe(1);
		expect(r.snapshot().activity).toHaveLength(2);
	});

	it("excludes subagent messages from turns and activity", () => {
		const r = reducer();
		r.consumeLine(assistantWithTools([{ id: "t1", name: "Read", input: {} }], "parent-1"));
		expect(r.snapshot()).toMatchObject({ turns: 0, activity: [] });
	});

	it("marks an entry done or failed by tool_use_id", () => {
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
				{ id: "t2", name: "Read", input: { file_path: "/repo/b.ts" } },
			]),
		);
		r.consumeLine(toolResult("t1", false));
		r.consumeLine(toolResult("t2", true));
		expect(r.snapshot().activity.map((entry) => entry.state)).toEqual(["done", "failed"]);
	});

	it("ignores a result for an entry evicted from the ring", () => {
		const r = reducer();
		for (let i = 0; i < ACTIVITY_LIMIT + 1; i += 1) {
			r.consumeLine(assistantWithTools([{ id: `t${i}`, name: "Read", input: {} }]));
		}
		r.consumeLine(toolResult("t0", false));
		const { activity } = r.snapshot();
		expect(activity).toHaveLength(ACTIVITY_LIMIT);
		expect(activity.every((entry) => entry.state !== "done")).toBe(true);
	});

	it("advances the phase through the tracker", () => {
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Bash", input: { command: "PREP_FILE=$(stagereview prep)" } },
			]),
		);
		r.consumeLine(toolResult("t1", false));
		expect(r.snapshot().phase).toBe(GENERATION_PHASE.ANALYZE);
	});

	it("counts malformed JSON without throwing", () => {
		const r = reducer();
		r.consumeLine("not json at all");
		r.consumeLine("");
		expect(r.droppedLines).toBe(1);
		expect(r.snapshot().turns).toBe(0);
	});

	it("counts a known event with a broken payload", () => {
		const r = reducer();
		r.consumeLine(JSON.stringify({ type: "assistant", message: "nope" }));
		expect(r.droppedLines).toBe(1);
	});

	it("does not count an unknown event type", () => {
		const r = reducer();
		r.consumeLine(JSON.stringify({ type: "stream_event", delta: {} }));
		expect(r.droppedLines).toBe(0);
	});

	it("records the result and takes its canonical turn count", () => {
		const r = reducer();
		r.consumeLine(assistantWithTools([{ id: "t1", name: "Read", input: {} }]));
		r.consumeLine(
			JSON.stringify({ type: "result", subtype: "success", result: "abc", num_turns: 17 }),
		);
		expect(r.result?.subtype).toBe("success");
		expect(r.snapshot().turns).toBe(17);
	});

	it("snapshots a wide-grapheme tool call the wire schema accepts", () => {
		const flag = "\u{1F1FA}\u{1F1F8}";
		const r = reducer();
		r.consumeLine(
			assistantWithTools([
				{ id: "t1", name: "Read", input: { file_path: `${REPO_ROOT}/${flag.repeat(200)}.ts` } },
				{ id: "t2", name: "Grep", input: { pattern: flag.repeat(200) } },
			]),
		);
		expect(JobProgressSchema.safeParse(r.snapshot())).toMatchObject({ success: true });
	});

	it("returns a snapshot later mutations do not touch", () => {
		const r = reducer();
		r.consumeLine(assistantWithTools([{ id: "t1", name: "Read", input: {} }]));
		const before = r.snapshot();
		r.consumeLine(toolResult("t1", false));
		expect(before.activity[0]?.state).toBe("running");
	});
});
