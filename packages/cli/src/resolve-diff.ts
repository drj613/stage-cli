import type { PullRequestFile } from "@stagereview/types/parsed-diff";
import { parseGitDiff } from "./diff-parser.js";
import { filterFilesForLlm, loadStageIgnore } from "./filter-files.js";
import { readRepoRoot } from "./git.js";
import type { Scope } from "./schema.js";
import { type DiffScopeOptions, resolveDiffScope } from "./scope.js";

/** Size of the reviewable part of a diff — the part an agent would be asked to chapter. */
export interface FilteredDiffStats {
	filteredFileCount: number;
	filteredHunkCount: number;
	/** Added plus removed lines across the reviewable files. */
	changedLines: number;
}

export interface ResolvedFilteredDiff {
	scope: Scope;
	/** The reviewed PR's number when `--pr` was used, else null. */
	prNumber: number | null;
	mergeBaseSha: string;
	/** Every file in the diff, including the ones excluded from review. */
	allFiles: PullRequestFile[];
	/** The reviewable files: `allFiles` minus `excludedByPath`. */
	files: PullRequestFile[];
	/** Paths dropped as lockfiles, generated files, binaries, or by `.stageignore`. */
	excludedByPath: string[];
	stats: FilteredDiffStats;
}

/**
 * The one place a diff becomes "what counts". Prep hands the reviewable hunks to
 * the agent from here, and the daemon decides whether to spawn an agent at all
 * from here, so the two can never disagree about which files are in scope.
 */
export async function resolveFilteredDiff(
	options: DiffScopeOptions,
): Promise<ResolvedFilteredDiff> {
	const { scope, rawDiff, mergeBaseSha, prNumber } = await resolveDiffScope(options);

	const allFiles = parseGitDiff(rawDiff);
	const stageIgnore = loadStageIgnore(readRepoRoot(options.cwd));
	const { files, excludedByPath } = filterFilesForLlm(allFiles, stageIgnore);

	return { scope, prNumber, mergeBaseSha, allFiles, files, excludedByPath, stats: statsFor(files) };
}

function statsFor(files: PullRequestFile[]): FilteredDiffStats {
	let filteredHunkCount = 0;
	let changedLines = 0;
	for (const file of files) {
		filteredHunkCount += file.hunks.length;
		changedLines += file.additions + file.deletions;
	}
	return { filteredFileCount: files.length, filteredHunkCount, changedLines };
}
