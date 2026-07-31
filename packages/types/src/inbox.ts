import { z } from "zod";

export const InboxPullRequestSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	repository: z.string(), // "owner/repo"
	author: z.string().nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
	/** runId when a run already exists for this PR in this repo, else null. */
	runId: z.string().nullable(),
});
export type InboxPullRequest = z.infer<typeof InboxPullRequestSchema>;

export const InboxResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), pullRequests: z.array(InboxPullRequestSchema) }),
]);
export type InboxResponse = z.infer<typeof InboxResponseSchema>;
