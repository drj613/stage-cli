import { z } from "zod";
import { DashboardPullRequestSchema } from "./pull-requests.ts";

export const CloneOwnerSchema = z.object({ owner: z.string(), cloneCount: z.number() });
export type CloneOwnerSummary = z.infer<typeof CloneOwnerSchema>;

export const OwnersResponseSchema = z.object({ owners: z.array(CloneOwnerSchema) });
export type OwnersResponse = z.infer<typeof OwnersResponseSchema>;

export const BrowseRepoSchema = z.object({
	nameWithOwner: z.string(),
	description: z.string().nullable(),
	updatedAt: z.string(),
	cloned: z.boolean(),
});
export type BrowseRepo = z.infer<typeof BrowseRepoSchema>;

export const OwnerReposResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), repos: z.array(BrowseRepoSchema) }),
]);
export type OwnerReposResponse = z.infer<typeof OwnerReposResponseSchema>;

export const RepoPullsResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), pullRequests: z.array(DashboardPullRequestSchema) }),
]);
export type RepoPullsResponse = z.infer<typeof RepoPullsResponseSchema>;
