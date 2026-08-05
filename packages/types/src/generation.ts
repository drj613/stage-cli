import { z } from "zod";

export const GENERATION_MODEL = {
	SONNET: "sonnet",
	OPUS: "opus",
	HAIKU: "haiku",
} as const;
export type GenerationModel = (typeof GENERATION_MODEL)[keyof typeof GENERATION_MODEL];

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

/**
 * The four boundaries actually observable in the agent's tool stream. The
 * stage-chapters skill has six numbered steps, but "finished reading, started
 * thinking" emits no signal — four honest phases beat six with two guesses.
 */
export const GENERATION_PHASE = {
	PREP: "prep",
	ANALYZE: "analyze",
	WRITE: "write",
	IMPORT: "import",
} as const;
export type GenerationPhase = (typeof GENERATION_PHASE)[keyof typeof GENERATION_PHASE];

/**
 * Display order, and the ordinal the tracker's monotonic rule compares. Derived
 * from the enum so declaration order *is* display order — string-key insertion
 * order is spec-guaranteed, and a new phase cannot be left out of the list.
 */
export const GENERATION_PHASE_ORDER = Object.values(GENERATION_PHASE);
