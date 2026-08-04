import { z } from "zod";

export const PR_FILTER = {
	REVIEW_REQUESTED: "review-requested",
	ASSIGNEE: "assignee",
	AUTHOR: "author",
} as const;
export type PrFilter = (typeof PR_FILTER)[keyof typeof PR_FILTER];

export const DashboardPullRequestSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	repository: z.string(), // "owner/repo"
	author: z.string().nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
	/** runId when a run already exists for this PR, else null. */
	runId: z.string().nullable(),
	/** Whether a usable local clone of the repo is known. */
	cloned: z.boolean(),
});
export type DashboardPullRequest = z.infer<typeof DashboardPullRequestSchema>;

export const PullRequestListResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), pullRequests: z.array(DashboardPullRequestSchema) }),
]);
export type PullRequestListResponse = z.infer<typeof PullRequestListResponseSchema>;

export const PR_RESOLUTION = {
	READY: "ready",
	STALE: "stale",
	GENERATING: "generating",
	FAILED: "failed",
	NEEDS_GENERATION: "needs-generation",
	NO_CLONE: "no-clone",
} as const;
export type PrResolutionState = (typeof PR_RESOLUTION)[keyof typeof PR_RESOLUTION];

/**
 * What GET /api/pull-requests/:owner/:repo/:number returns. Always 200 when
 * the request is well-formed — the states are peers, not errors (see design
 * doc: a 422 here would reach jsonFetch as an opaque thrown error).
 */
export const PrResolutionSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal(PR_RESOLUTION.READY), runId: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.STALE), runId: z.string(), headSha: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.GENERATING), jobId: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.FAILED), jobId: z.string(), error: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.NEEDS_GENERATION) }),
	z.object({ state: z.literal(PR_RESOLUTION.NO_CLONE), nameWithOwner: z.string() }),
]);
export type PrResolution = z.infer<typeof PrResolutionSchema>;
