import {
	ACTIVITY_STATE,
	type ActivityState,
	GENERATION_PHASE,
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
