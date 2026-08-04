import { z } from "zod";

export const CloneRootSchema = z.object({
	path: z.string(),
	addedAt: z.string(), // ISO — Drizzle Date serialized through JSON
});
export type CloneRoot = z.infer<typeof CloneRootSchema>;

export const CloneRootsResponseSchema = z.object({ roots: z.array(CloneRootSchema) });
export type CloneRootsResponse = z.infer<typeof CloneRootsResponseSchema>;

export const RescanResponseSchema = z.object({
	repoCount: z.number(),
	ownerCount: z.number(),
});
export type RescanResponse = z.infer<typeof RescanResponseSchema>;
