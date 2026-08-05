import type { HunkReference } from "@stagereview/types/chapters";
import { buildOtherChangesChapter } from "./build-other-changes.js";
import type { ResolvedFilteredDiff } from "./resolve-diff.js";
import type { Chapter, ChaptersFile } from "./schema.js";

const ALL_CHANGES_CHAPTER_ID = "chapter-all-changes";
const ALL_CHANGES_TITLE = "All changes";
const ALL_CHANGES_SUMMARY =
	"This change is small enough to review directly, so chapter generation was skipped.";

/**
 * The chapters file for a diff no agent ever looked at: one chapter holding
 * every reviewable hunk, plus the usual "Other changes" chapter for what the
 * filter dropped. Hunk coverage is exact by construction — the refs are
 * generated from the same filtered files the coverage check would compare
 * against — so nothing here needs validating.
 *
 * There is no prologue. The skill asks a prologue to carry two to five key changes
 * and one to five focus areas, and nothing but an agent can produce those honestly.
 */
export function buildSyntheticChaptersFile(diff: ResolvedFilteredDiff): ChaptersFile {
	const chapters: Chapter[] = [];

	// A chapter with no hunks is a row the reviewer can only click into and find
	// empty, so a diff that is entirely lockfiles gets the other-changes chapter alone.
	if (diff.stats.filteredHunkCount > 0) {
		chapters.push({
			id: ALL_CHANGES_CHAPTER_ID,
			order: 1,
			title: ALL_CHANGES_TITLE,
			summary: ALL_CHANGES_SUMMARY,
			hunkRefs: hunkRefsFor(diff),
			keyChanges: [],
		});
	}

	const otherChanges = buildOtherChangesChapter(diff.allFiles, diff.excludedByPath);
	if (otherChanges) {
		chapters.push({ ...otherChanges, order: chapters.length + 1 });
	}

	return { scope: diff.scope, chapters, generatedAt: new Date().toISOString() };
}

function hunkRefsFor(diff: ResolvedFilteredDiff): HunkReference[] {
	const hunkRefs: HunkReference[] = [];
	for (const file of diff.files) {
		for (const hunk of file.hunks) {
			hunkRefs.push({ filePath: file.path, oldStart: hunk.oldStart });
		}
	}
	return hunkRefs;
}
