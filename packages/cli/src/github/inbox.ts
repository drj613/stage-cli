import type { InboxPullRequest } from "@stagereview/types/inbox";
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

/**
 * Map raw `gh search prs --json` items into the inbox wire shape. Items that
 * don't match the expected gh output shape are silently dropped rather than
 * failing the whole inbox — a malformed row shouldn't hide the rest. Dropped
 * rows are logged (once, with a count) so the mismatch isn't invisible.
 */
export function mapSearchResults(
	raw: unknown[],
	runIdFor: (repo: string, prNumber: number) => string | null,
): InboxPullRequest[] {
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
				runId: runIdFor(pr.repository.nameWithOwner, pr.number),
			},
		];
	});
	if (dropped > 0) {
		console.warn(`inbox: dropped ${dropped} malformed gh search prs row(s)`);
	}
	return pullRequests;
}

/** PRs across all orgs awaiting the signed-in user's review. Throws on gh failure. */
export async function searchReviewRequested(cwd: string): Promise<unknown[]> {
	const stdout = await gh(
		[
			"search",
			"prs",
			"--review-requested=@me",
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
