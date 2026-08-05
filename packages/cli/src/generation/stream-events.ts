import { z } from "zod";
import { sanitizeText } from "./describe-tool-use.js";

const TOOL_USE = "tool_use";
const TOOL_RESULT = "tool_result";
const SUCCESS = "success";

const ToolUseBlockSchema = z.object({
	type: z.literal(TOOL_USE),
	id: z.string(),
	name: z.string(),
	input: z.unknown(),
});
const ToolResultBlockSchema = z.object({
	type: z.literal(TOOL_RESULT),
	tool_use_id: z.string(),
	is_error: z.boolean().optional(),
});

/**
 * Text, thinking, and anything the wire format grows later — but never the two
 * types above. Graceful growth only needs *unrecognized* types to survive; if
 * this accepted a malformed `tool_use`, the block would keep its discriminator
 * while losing its `id` and `name`, and a reducer switching on the type would
 * match a block with nothing in it.
 */
const OtherBlockSchema = z.object({
	type: z.string().refine((type) => type !== TOOL_USE && type !== TOOL_RESULT),
});

const ContentBlockSchema = z.union([ToolUseBlockSchema, ToolResultBlockSchema, OtherBlockSchema]);
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * Narrowing a parsed block on its `type` does not work: {@link OtherBlockSchema}
 * infers `type` as a plain string, so the union is not discriminated and a literal
 * comparison excludes nothing. These key off each block's required field instead,
 * which is exact rather than a heuristic — `z.object` strips unknown keys, so an
 * unrecognized block carries only `type`, and the two schemas above reject a
 * `tool_use` without an `id` or a `tool_result` without a `tool_use_id`.
 *
 * The invariant lives here, beside the schemas that establish it.
 */
export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return "id" in block;
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
	return "tool_use_id" in block;
}

const InitEventSchema = z.object({
	type: z.literal("system"),
	subtype: z.literal("init"),
	model: z.string(),
});

/**
 * `parent_tool_use_id` is non-null for subagent traffic. Those messages are not
 * top-level turns and their tools are not the main agent's work.
 */
const MessageEventSchema = z.object({
	parent_tool_use_id: z.string().nullish(),
	message: z.object({ content: z.array(ContentBlockSchema) }),
});
const AssistantEventSchema = MessageEventSchema.extend({ type: z.literal("assistant") });
const UserEventSchema = MessageEventSchema.extend({ type: z.literal("user") });

/**
 * `num_turns` feeds `JobProgress.turns`, which the SPA parses with the same
 * bounds. A value this schema let through but that one forbids would put the
 * dashboard's poll into a permanent error state, so it is bounded on the way in.
 */
const TurnCountSchema = z.number().int().nonnegative().optional();

/**
 * A plain union, not a discriminated one: `result` exists only on the success
 * variant, so `{ subtype: "success" }` with no text fails validation rather than
 * parsing into a success with a missing field. Failing here routes it to the
 * "exited without a result event" path instead of an internal null check.
 *
 * The error variant refuses the success subtype for the same reason. Without
 * that, `{ subtype: "success", is_error: true }` would parse as an error yet
 * satisfy `isSuccessResult`, whose narrowing then promises a `result` string
 * that does not exist. The two variants are disjoint by construction, so their
 * order in the union is not observable.
 */
const SuccessResultSchema = z.object({
	type: z.literal("result"),
	subtype: z.literal(SUCCESS),
	result: z.string(),
	num_turns: TurnCountSchema,
});
const ErrorResultSchema = z.object({
	type: z.literal("result"),
	subtype: z.string().refine((subtype) => subtype !== SUCCESS),
	is_error: z.literal(true),
	error: z.string().optional(),
	errors: z.array(z.string()).optional(),
	num_turns: TurnCountSchema,
});
const ResultEventSchema = z.union([SuccessResultSchema, ErrorResultSchema]);

export type SuccessResultEvent = z.infer<typeof SuccessResultSchema>;
export type ErrorResultEvent = z.infer<typeof ErrorResultSchema>;
export type ResultEvent = z.infer<typeof ResultEventSchema>;
export type StreamEvent =
	| z.infer<typeof InitEventSchema>
	| z.infer<typeof AssistantEventSchema>
	| z.infer<typeof UserEventSchema>
	| ResultEvent;

export function isSuccessResult(event: ResultEvent): event is SuccessResultEvent {
	return event.subtype === SUCCESS;
}

const TypedSchema = z.object({ type: z.string() });

/**
 * Three outcomes, deliberately distinct:
 *
 * - `unknown` — an event type we don't model. Ignored, because the wire format
 *   gains variants and a new one must not fail a run.
 * - `invalid` — a type we *do* model whose payload is broken. Counted as a
 *   dropped line, so a corrupt stream is visible in any failure message.
 * - `event` — usable.
 *
 * One exception to `invalid`: a broken `system`/`init` is reported `unknown`,
 * because `system` carries subtypes beyond `init` and only `init` has a model.
 * The cost is that a corrupt init line goes uncounted and `resolvedModel` stays
 * null for the run.
 */
export type ParseOutcome =
	| { outcome: "event"; event: StreamEvent }
	| { outcome: "unknown" }
	| { outcome: "invalid" };

function classify(result: z.ZodSafeParseResult<StreamEvent>): ParseOutcome {
	return result.success ? { outcome: "event", event: result.data } : { outcome: "invalid" };
}

/**
 * The switch dispatches on an arbitrary string, so a schema added without a case
 * here silently falls through to `unknown`. A per-type test is the only guard.
 */
export function parseStreamEvent(raw: unknown): ParseOutcome {
	const typed = TypedSchema.safeParse(raw);
	if (!typed.success) return { outcome: "invalid" };
	switch (typed.data.type) {
		case "system": {
			// `system` covers more subtypes than init; only init carries the model.
			const init = InitEventSchema.safeParse(raw);
			return init.success ? { outcome: "event", event: init.data } : { outcome: "unknown" };
		}
		case "assistant":
			return classify(AssistantEventSchema.safeParse(raw));
		case "user":
			return classify(UserEventSchema.safeParse(raw));
		case "result":
			return classify(ResultEventSchema.safeParse(raw));
		default:
			return { outcome: "unknown" };
	}
}

/**
 * A Map, not an object literal: the subtype is unvalidated wire data, and a
 * plain-object lookup for `constructor` or `toString` returns an inherited
 * member rather than a miss.
 */
const SUBTYPE_PHRASES: ReadonlyMap<string, string> = new Map([
	["error_max_turns", "The agent hit its turn limit."],
	["error_during_execution", "The agent errored during execution."],
]);

/** Long enough for a real stack-free diagnostic, short enough to store and render. */
const MESSAGE_LIMIT = 500;
/** Slack for what sanitizing strips, so a trim never loses visible characters. */
const RAW_LIMIT = MESSAGE_LIMIT * 4;
const MAX_ERROR_LINES = 10;

/**
 * Trims before sanitizing, not after. Sanitizing walks the string character by
 * character and segments it into graphemes: on a 10 MB payload that is seconds of
 * a single-threaded server, all to discard everything past 500 characters.
 */
function clean(text: string): string {
	return sanitizeText(text.slice(0, RAW_LIMIT)).slice(0, MESSAGE_LIMIT);
}

/**
 * Error results carry no final text — `result` is success-only — so the message
 * is assembled from whatever diagnostic fields the event does have. Every part
 * comes from the agent's stdout, so each is sanitized and the result is bounded
 * to MESSAGE_LIMIT including the prefix.
 */
export function errorResultMessage(event: ErrorResultEvent): string {
	const joined = event.errors
		?.slice(0, MAX_ERROR_LINES)
		.map(clean)
		.filter((line) => line !== "")
		.join("; ");
	if (joined !== undefined && joined !== "") return joined.slice(0, MESSAGE_LIMIT);
	const single = event.error === undefined ? "" : clean(event.error);
	if (single !== "") return single;
	const phrase = SUBTYPE_PHRASES.get(event.subtype);
	if (phrase !== undefined) return phrase;
	return `Agent failed: ${clean(event.subtype)}`.slice(0, MESSAGE_LIMIT);
}
