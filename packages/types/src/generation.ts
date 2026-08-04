import { z } from "zod";

export const JOB_STATUS = {
	QUEUED: "queued",
	RUNNING: "running",
	SUCCEEDED: "succeeded",
	FAILED: "failed",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export function isTerminalJobStatus(status: JobStatus): boolean {
	return status === JOB_STATUS.SUCCEEDED || status === JOB_STATUS.FAILED;
}

/** What GET /api/generate/:jobId returns — the public face of a generation job. */
export const GenerationJobSchema = z.object({
	id: z.string(),
	status: z.enum(JOB_STATUS),
	/** Set once the job succeeds. */
	runId: z.string().nullable(),
	error: z.string().nullable(),
	/** 1-based place in line while queued; null when running or terminal. */
	queuePosition: z.number().nullable(),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

export const GenerateAcceptedSchema = z.object({ jobId: z.string() });
export type GenerateAccepted = z.infer<typeof GenerateAcceptedSchema>;
