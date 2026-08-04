import type { DashboardPullRequest } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { dedupeAgainst } from "../dedupe-pull-requests";

function pr(url: string): DashboardPullRequest {
	return {
		number: 1,
		title: "t",
		url,
		repository: "o/r",
		author: null,
		isDraft: false,
		updatedAt: "2026-08-04T00:00:00Z",
		runId: null,
		cloned: true,
	};
}

describe("dedupeAgainst", () => {
	it("drops rows whose url appears in a resolved higher section", () => {
		expect(dedupeAgainst([pr("a"), pr("b")], [[pr("a")]])).toEqual([pr("b")]);
	});

	it("suppresses nothing for higher sections that have not resolved (null)", () => {
		expect(dedupeAgainst([pr("a")], [null])).toEqual([pr("a")]);
	});

	it("compares urls case-insensitively", () => {
		expect(
			dedupeAgainst([pr("https://github.com/O/R/pull/1")], [[pr("https://github.com/o/r/pull/1")]]),
		).toEqual([]);
	});
});
