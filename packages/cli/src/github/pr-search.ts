import type { DashboardPullRequest, PrFilter } from "@stagereview/types/pull-requests";
import { PR_FILTER } from "@stagereview/types/pull-requests";
import { z } from "zod";
import { gh } from "./exec.js";

const GhSearchPrSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	repository: z.object({ nameWithOwner: z.string() }),
	author: z.object({ login: z.string() }).nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
});

const SEARCH_FIELDS = "number,title,url,repository,author,isDraft,updatedAt";
const SEARCH_LIMIT = 50;

const SEARCH_FLAG: Record<PrFilter, string> = {
	[PR_FILTER.REVIEW_REQUESTED]: "--review-requested=@me",
	[PR_FILTER.ASSIGNEE]: "--assignee=@me",
	[PR_FILTER.AUTHOR]: "--author=@me",
};

/** The `gh search prs` flag that selects PRs matching a dashboard filter. */
export function searchFlagFor(filter: PrFilter): string {
	return SEARCH_FLAG[filter];
}

export interface SearchResultDeps {
	runIdFor: (repo: string, prNumber: number) => string | null;
	isCloned: (repo: string) => boolean;
}

/**
 * Map raw `gh search prs --json` items into the dashboard PR wire shape. Items
 * that don't match the expected gh output shape are dropped rather than
 * failing the whole search — a malformed row shouldn't hide the rest. Dropped
 * rows are logged (once, with a count) so the mismatch isn't invisible.
 */
export function mapSearchResults(raw: unknown[], deps: SearchResultDeps): DashboardPullRequest[] {
	let dropped = 0;
	const pullRequests = raw.flatMap((item) => {
		const parsed = GhSearchPrSchema.safeParse(item);
		if (!parsed.success) {
			dropped++;
			return [];
		}
		const pr = parsed.data;
		return [
			{
				number: pr.number,
				title: pr.title,
				url: pr.url,
				repository: pr.repository.nameWithOwner,
				author: pr.author?.login ?? null,
				isDraft: pr.isDraft,
				updatedAt: pr.updatedAt,
				runId: deps.runIdFor(pr.repository.nameWithOwner, pr.number),
				cloned: deps.isCloned(pr.repository.nameWithOwner),
			},
		];
	});
	if (dropped > 0) {
		console.warn(`pull-requests: dropped ${dropped} malformed gh search prs row(s)`);
	}
	return pullRequests;
}

/** Open PRs matching the filter across all orgs. Throws on gh failure. */
export async function searchPullRequests(filter: PrFilter, cwd: string): Promise<unknown[]> {
	const stdout = await gh(
		[
			"search",
			"prs",
			searchFlagFor(filter),
			"--state=open",
			"--limit",
			String(SEARCH_LIMIT),
			"--json",
			SEARCH_FIELDS,
		],
		cwd,
	);
	return z.array(z.unknown()).parse(JSON.parse(stdout));
}
