import { z } from "zod";
import { SCOPE_KIND } from "./scope.ts";

export const RunSummarySchema = z.object({
	id: z.string(),
	repoName: z.string(),
	prNumber: z.number().nullable(),
	scopeKind: z.enum(SCOPE_KIND),
	generatedAt: z.string(),
	chapterCount: z.number(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunListResponseSchema = z.object({
	runs: z.array(RunSummarySchema),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
