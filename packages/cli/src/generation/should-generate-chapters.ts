import type { FilteredDiffStats } from "../resolve-diff.js";

/**
 * A diff at or under every one of these is small enough to read straight
 * through, so clustering it into chapters costs an agent run and buys the
 * reviewer nothing. Reasoned, not measured — there is no telemetry to tune them
 * against yet, so they are named and easy to move.
 */
const SMALL_DIFF = {
	MAX_HUNKS: 3,
	MAX_FILES: 2,
	MAX_CHANGED_LINES: 40,
} as const;

/** Whether a diff is worth handing to the chapter-generating agent. */
export function shouldGenerateChapters(stats: FilteredDiffStats): boolean {
	// Nothing survived filtering, so the agent would have no hunks to cluster.
	if (stats.filteredHunkCount === 0) return false;

	const isSmall =
		stats.filteredHunkCount <= SMALL_DIFF.MAX_HUNKS &&
		stats.filteredFileCount <= SMALL_DIFF.MAX_FILES &&
		stats.changedLines <= SMALL_DIFF.MAX_CHANGED_LINES;
	return !isSmall;
}
