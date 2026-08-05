import { z } from "zod";
import { sanitizeText } from "./describe-tool-use.js";

const ToolUseBlockSchema = z.object({
	type: z.literal("tool_use"),
	id: z.string(),
	name: z.string(),
	input: z.unknown(),
});
const ToolResultBlockSchema = z.object({
	type: z.literal("tool_result"),
	tool_use_id: z.string(),
	is_error: z.boolean().optional(),
});
/** Text, thinking, and anything the wire format grows later. */
const OtherBlockSchema = z.object({ type: z.string() });

const ContentBlockSchema = z.union([ToolUseBlockSchema, ToolResultBlockSchema, OtherBlockSchema]);
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

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
 * A plain union, not a discriminated one: `result` exists only on the success
 * variant, so `{ subtype: "success" }` with no text must fail validation rather
 * than parse into a success with a missing field. Failing here routes it to the
 * "exited without a result event" path instead of an internal null check.
 */
const SuccessResultSchema = z.object({
	type: z.literal("result"),
	subtype: z.literal("success"),
	result: z.string(),
	num_turns: z.number().optional(),
});
const ErrorResultSchema = z.object({
	type: z.literal("result"),
	subtype: z.string(),
	is_error: z.literal(true),
	error: z.string().optional(),
	errors: z.array(z.string()).optional(),
	num_turns: z.number().optional(),
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
	return event.subtype === "success";
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
 */
export type ParseOutcome =
	| { outcome: "event"; event: StreamEvent }
	| { outcome: "unknown" }
	| { outcome: "invalid" };

function classify<T extends StreamEvent>(result: z.ZodSafeParseResult<T>): ParseOutcome {
	return result.success ? { outcome: "event", event: result.data } : { outcome: "invalid" };
}

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

/**
 * Error results carry no final text — `result` is success-only — so the message
 * is assembled from whatever diagnostic fields the event does have. Every part
 * comes from the agent's stdout, so each is sanitized and the whole is bounded.
 */
export function errorResultMessage(event: ErrorResultEvent): string {
	const joined = event.errors
		?.map(sanitizeText)
		.filter((line) => line !== "")
		.join("; ");
	if (joined !== undefined && joined !== "") return joined.slice(0, MESSAGE_LIMIT);
	const single = event.error === undefined ? "" : sanitizeText(event.error);
	if (single !== "") return single.slice(0, MESSAGE_LIMIT);
	const phrase = SUBTYPE_PHRASES.get(event.subtype);
	if (phrase !== undefined) return phrase;
	return `Agent failed: ${sanitizeText(event.subtype).slice(0, MESSAGE_LIMIT)}`;
}
