import { describe, expect, it } from "vitest";
import { mapSearchResults } from "../github/inbox.js";

describe("mapSearchResults", () => {
	it("maps a gh search prs item to the wire shape and attaches the runId lookup result", () => {
		const item = {
			number: 7,
			title: "Add stack navigator",
			url: "https://github.com/acme/widgets/pull/7",
			repository: { nameWithOwner: "acme/widgets" },
			author: { login: "sam" },
			isDraft: false,
			updatedAt: "2026-07-30T12:00:00Z",
		};
		const runIdLookup = (repo: string, prNumber: number): string | null =>
			repo === "acme/widgets" && prNumber === 7 ? "run-123" : null;

		expect(mapSearchResults([item], runIdLookup)).toEqual([
			{
				number: 7,
				title: "Add stack navigator",
				url: "https://github.com/acme/widgets/pull/7",
				repository: "acme/widgets",
				author: "sam",
				isDraft: false,
				updatedAt: "2026-07-30T12:00:00Z",
				runId: "run-123",
			},
		]);
	});

	it("drops items that don't match the expected gh search prs shape", () => {
		expect(mapSearchResults([{ nonsense: true }], () => null)).toEqual([]);
	});
});
