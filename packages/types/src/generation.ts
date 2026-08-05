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

export const ACTIVITY_STATE = {
	RUNNING: "running",
	DONE: "done",
	FAILED: "failed",
} as const;
export type ActivityState = (typeof ACTIVITY_STATE)[keyof typeof ACTIVITY_STATE];

/**
 * Hard ceilings in UTF-16 code units — the unit `z.string().max()` counts.
 *
 * The server caps what it renders in *grapheme clusters*, so its display budget
 * and these are different units: one flag emoji is one grapheme and four code
 * units. Both sides import these so the producer can bound itself in the same
 * unit the boundary measures. Let them drift and a single wide-grapheme file path
 * makes every snapshot unparseable, which parks the dashboard's poll in a
 * permanent error state — the failure the turn-count bound exists to prevent.
 */
export const TARGET_LIMIT = 200;
export const TOOL_LIMIT = 40;

export const ActivityEntrySchema = z.object({
	tool: z.string().max(TOOL_LIMIT),
	/**
	 * The server emits this collapsed to one line and capped; consumers must not
	 * assume any particular length. Empty for tools with no meaningful target and
	 * for inputs the server could not parse, which is normal — render the tool
	 * name alone rather than a dangling separator.
	 */
	target: z.string().max(TARGET_LIMIT),
	state: z.enum(ACTIVITY_STATE),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/** How many activity entries the server retains and sends. */
export const ACTIVITY_LIMIT = 20;

export const JobProgressSchema = z.object({
	/** Epoch ms, set when the child process spawns. */
	startedAt: z.number().int().positive(),
	/**
	 * The full model identifier the CLI reports in its init event, such as
	 * `claude-sonnet-4-5-20250929` — NOT a GENERATION_MODEL alias. Null until
	 * that event arrives, a few seconds into a run.
	 *
	 * This and the job's `requestedModel` are two vocabularies for one piece of
	 * information, so the SPA must format both into a single short label. Render
	 * them raw and the display changes vocabulary mid-run: `sonnet`, then a long
	 * dated identifier.
	 */
	resolvedModel: z.string().nullable(),
	/**
	 * Top-level assistant messages seen so far; a subagent's messages do not
	 * count. Not monotonic: the agent's final result event reports its own turn
	 * total, which replaces the running count and may be lower. Show it as a
	 * figure, not an animated counter.
	 */
	turns: z.number().int().nonnegative(),
	phase: z.enum(GENERATION_PHASE),
	/** Oldest first, at most ACTIVITY_LIMIT entries. */
	activity: z.array(ActivityEntrySchema).max(ACTIVITY_LIMIT),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

/** What GET /api/generate/:jobId returns — the public face of a generation job. */
export const GenerationJobSchema = z.object({
	id: z.string(),
	/** Canonical PR URL, so the dashboard can match a job to a row. */
	prUrl: z.url(),
	status: z.enum(JOB_STATUS),
	/** Known at enqueue time, so it is present even while queued. */
	requestedModel: z.enum(GENERATION_MODEL),
	/** Set once the job succeeds. */
	runId: z.string().nullable(),
	error: z.string().nullable(),
	/** 1-based place in line while queued; null when running or terminal. */
	queuePosition: z.number().int().positive().nullable(),
	/** Null while queued, and for a job whose process never spawned. */
	progress: JobProgressSchema.nullable(),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

/** What GET /api/generate returns — every job that has not reached a terminal status. */
export const ActiveGenerationJobsSchema = z.object({ jobs: z.array(GenerationJobSchema) });
export type ActiveGenerationJobs = z.infer<typeof ActiveGenerationJobsSchema>;

export const GenerateAcceptedSchema = z.object({ jobId: z.string() });
export type GenerateAccepted = z.infer<typeof GenerateAcceptedSchema>;
