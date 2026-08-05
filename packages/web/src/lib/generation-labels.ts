import {
	ACTIVITY_STATE,
	type ActivityState,
	GENERATION_MODEL,
	GENERATION_PHASE,
	type GenerationJob,
	type GenerationModel,
	type GenerationPhase,
	JOB_STATUS,
} from "@stagereview/types/generation";

export const PHASE_LABELS: Readonly<Record<GenerationPhase, string>> = {
	[GENERATION_PHASE.PREP]: "Prep the diff",
	[GENERATION_PHASE.ANALYZE]: "Read & analyze",
	[GENERATION_PHASE.WRITE]: "Write chapters",
	[GENERATION_PHASE.IMPORT]: "Import",
};

/** Short form for a dashboard row, where the full label doesn't fit. */
export const PHASE_BADGES: Readonly<Record<GenerationPhase, string>> = {
	[GENERATION_PHASE.PREP]: "Prep",
	[GENERATION_PHASE.ANALYZE]: "Analyze",
	[GENERATION_PHASE.WRITE]: "Write",
	[GENERATION_PHASE.IMPORT]: "Import",
};

/**
 * What a dashboard row's badge says about a job in flight.
 *
 * Three states, not four: a job is queued, running with nothing reported yet
 * (the child process hasn't spawned, so there is no phase to name), or running
 * with a phase. The badge names the current phase only. The tracker never
 * rewinds, but it does skip — an `import` proves the earlier phases happened
 * without ever having reported them — so the phase on show is not a count of
 * phases completed.
 */
export function formatJobBadge(job: GenerationJob): string {
	if (job.status === JOB_STATUS.QUEUED) {
		return job.queuePosition === null ? "Queued" : `Queued #${job.queuePosition}`;
	}
	return job.progress === null ? "Starting" : PHASE_BADGES[job.progress.phase];
}

/**
 * The one line the resolver card can honestly show before any snapshot exists.
 *
 * `queuePosition` is a 1-based place in line and the running job is already off
 * the queue, so position 1 has nothing ahead of it. Stating the position keeps
 * that true without the arithmetic — and without the awkward "0 ahead" — that
 * counting the jobs in front would need.
 */
export function formatQueueStatus(queuePosition: number | null): string {
	return queuePosition === null ? "Chaptering…" : `Queued — position ${queuePosition}`;
}

/** Accessible names for the state glyphs — the icon is never the only signal. */
export const ACTIVITY_STATE_LABELS: Readonly<Record<ActivityState, string>> = {
	[ACTIVITY_STATE.RUNNING]: "Running",
	[ACTIVITY_STATE.DONE]: "Done",
	[ACTIVITY_STATE.FAILED]: "Failed",
};

const MODEL_FAMILIES: readonly string[] = Object.values(GENERATION_MODEL);
/** `20250929` — the release date every current model id ends with. */
const RELEASE_DATE = /^\d{8}$/;
/**
 * Room for `4.5`, or `10.11` if the numbering ever gets there. `resolvedModel`
 * is an unbounded string on the wire, and the summary line it lands in has no
 * truncation, so an absurd id has to lose its version rather than reflow the
 * card. The family alone is still a correct label.
 */
const VERSION_BUDGET = 8;

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * One short label for the two vocabularies the wire carries: the requested
 * alias (`sonnet`) and the id the CLI resolved (`claude-sonnet-4-5-20250929`).
 * Both render as `Sonnet`, gaining a version once the init event lands
 * (`Sonnet 4.5`) — so the label never swaps vocabulary mid-run the way printing
 * either field raw would.
 *
 * Tokenized rather than pattern-matched because the family has moved around
 * over time (`claude-3-5-haiku-…` vs `claude-sonnet-4-5-…`). An id with no
 * known family isn't ours to interpret, so the alias stands.
 */
export function formatModelLabel(
	requestedModel: GenerationModel,
	resolvedModel: string | null,
): string {
	if (resolvedModel === null) return capitalize(requestedModel);
	const tokens = resolvedModel.toLowerCase().split("-");
	const family = tokens.find((token) => MODEL_FAMILIES.includes(token));
	if (family === undefined) return capitalize(requestedModel);
	const version = tokens
		.filter((token) => /^\d+$/.test(token) && !RELEASE_DATE.test(token))
		.join(".");
	if (version === "" || version.length > VERSION_BUDGET) return capitalize(family);
	return `${capitalize(family)} ${version}`;
}
