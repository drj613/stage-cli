import { z } from "zod";
import { SCOPE_KIND } from "./scope.ts";

export const RunSummarySchema = z.object({
	id: z.string(),
	repoName: z.string(),
	/** PR numbers this run reviews, bottom of the stack first. Empty for a local run. */
	prNumbers: z.array(z.number()),
	scopeKind: z.enum(SCOPE_KIND),
	generatedAt: z.string(),
	chapterCount: z.number(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunListResponseSchema = z.object({
	runs: z.array(RunSummarySchema),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
