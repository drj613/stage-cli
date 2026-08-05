import {
	ACTIVITY_STATE,
	type ActivityState,
	GENERATION_MODEL,
	GENERATION_PHASE,
	type GenerationModel,
	type GenerationPhase,
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
