import { z } from "zod";
import { GENERATION_MODEL } from "./generation.ts";

/**
 * The body of `POST /api/generate`, shared by the route and the SPA so a change
 * to it is a type error rather than a runtime 400. One URL is a single-PR run;
 * several are a stack. Order is not significant — the server orders members by
 * ancestry, and dedupes jobs on the sorted set.
 */
export const GenerateRequestSchema = z.object({
	prUrls: z.array(z.url()).min(1),
	model: z.enum(GENERATION_MODEL).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
