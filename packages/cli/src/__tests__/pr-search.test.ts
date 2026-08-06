import { PR_FILTER } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { mapSearchResults, searchFlagFor } from "../github/pr-search.js";

interface GhRowOverrides {
	number?: number;
	title?: string;
	url?: string;
	repository?: { nameWithOwner: string };
	author?: { login: string } | null;
	isDraft?: boolean;
	updatedAt?: string;
}

function validGhRow(overrides: GhRowOverrides = {}) {
	return {
		number: 7,
		title: "Add stack navigator",
		url: "https://github.com/acme/widgets/pull/7",
		repository: { nameWithOwner: "acme/widgets" },
		author: { login: "sam" },
		isDraft: false,
		updatedAt: "2026-07-30T12:00:00Z",
		...overrides,
	};
}

describe("searchFlagFor", () => {
	it("maps each filter to its gh search flag", () => {
		expect(searchFlagFor(PR_FILTER.REVIEW_REQUESTED)).toBe("--review-requested=@me");
		expect(searchFlagFor(PR_FILTER.ASSIGNEE)).toBe("--assignee=@me");
		expect(searchFlagFor(PR_FILTER.AUTHOR)).toBe("--author=@me");
	});
});

describe("mapSearchResults", () => {
	it("maps a gh search prs item to the wire shape and attaches the runId lookup result", () => {
		const rows = mapSearchResults([validGhRow()], {
			runIdFor: (repo, prNumber) => (repo === "acme/widgets" && prNumber === 7 ? "run-123" : null),
			isCloned: () => false,
		});

		expect(rows).toEqual([
			{
				number: 7,
				title: "Add stack navigator",
				url: "https://github.com/acme/widgets/pull/7",
				repository: "acme/widgets",
				author: "sam",
				isDraft: false,
				updatedAt: "2026-07-30T12:00:00Z",
				runId: "run-123",
				cloned: false,
			},
		]);
	});

	it("maps a deleted-account author (null) to a null author on the wire", () => {
		const [pr] = mapSearchResults([validGhRow({ author: null, isDraft: true, number: 9 })], {
			runIdFor: () => null,
			isCloned: () => false,
		});
		expect(pr?.author).toBeNull();
	});

	it("drops items that don't match the expected gh search prs shape", () => {
		expect(
			mapSearchResults([{ nonsense: true }], { runIdFor: () => null, isCloned: () => false }),
		).toEqual([]);
	});

	it("marks rows cloned from the provided lookup", () => {
		const rows = mapSearchResults([validGhRow({ repository: { nameWithOwner: "o/r" } })], {
			runIdFor: () => null,
			isCloned: (repo) => repo === "o/r",
		});
		expect(rows[0]?.cloned).toBe(true);
	});
});
