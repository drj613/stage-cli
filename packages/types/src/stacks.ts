import { z } from "zod";

export const StackMemberSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	isDraft: z.boolean(),
});
export type StackMember = z.infer<typeof StackMemberSchema>;

/** One root-to-leaf chain, bottom first. Identified by its last member, the tip. */
export const StackChainSchema = z.object({
	members: z.array(StackMemberSchema).min(2),
});
export type StackChain = z.infer<typeof StackChainSchema>;

export const StackGraphSchema = z.object({
	/**
	 * False when `gh pr list` hit its cap, so a parent or child may exist beyond
	 * it. The UI shows no badges rather than a position that may be wrong.
	 */
	complete: z.boolean(),
	chains: z.array(StackChainSchema),
});
export type StackGraph = z.infer<typeof StackGraphSchema>;

export const StackResponseSchema = z.discriminatedUnion("available", [
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), graph: StackGraphSchema }),
]);
export type StackResponse = z.infer<typeof StackResponseSchema>;
