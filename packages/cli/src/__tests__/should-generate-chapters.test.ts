import { describe, expect, it } from "vitest";
import { shouldGenerateChapters } from "../generation/should-generate-chapters.js";
import type { FilteredDiffStats } from "../resolve-diff.js";

function stats(over: Partial<FilteredDiffStats> = {}): FilteredDiffStats {
	return { filteredFileCount: 2, filteredHunkCount: 3, changedLines: 40, ...over };
}

describe("shouldGenerateChapters", () => {
	it("skips a diff with nothing left to review after filtering", () => {
		expect(
			shouldGenerateChapters(
				stats({ filteredFileCount: 0, filteredHunkCount: 0, changedLines: 0 }),
			),
		).toBe(false);
	});

	it("skips a single-hunk diff", () => {
		expect(
			shouldGenerateChapters(
				stats({ filteredFileCount: 1, filteredHunkCount: 1, changedLines: 4 }),
			),
		).toBe(false);
	});

	it("skips a diff sitting exactly on every limit", () => {
		expect(shouldGenerateChapters(stats())).toBe(false);
	});

	it("generates once there is one hunk too many", () => {
		expect(shouldGenerateChapters(stats({ filteredHunkCount: 4 }))).toBe(true);
	});

	it("generates once there is one file too many", () => {
		expect(shouldGenerateChapters(stats({ filteredFileCount: 3 }))).toBe(true);
	});

	it("generates once there is one changed line too many", () => {
		expect(shouldGenerateChapters(stats({ changedLines: 41 }))).toBe(true);
	});
});
