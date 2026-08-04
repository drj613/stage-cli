import type { DashboardPullRequest } from "@stagereview/types/pull-requests";
import { z } from "zod";
import { gh } from "./exec.js";

const GhPrSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	author: z.object({ login: z.string() }).nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
});

/**
 * Deliberate cap, not pagination: Browse shows the 50 most recent open PRs of
 * a repo. Anything beyond that is reachable via its /pr/:owner/:repo/:number
 * URL or the dashboard search sections.
 */
const PR_LIST_LIMIT = 50;

export interface RepoPullDeps {
	runIdFor: (repo: string, prNumber: number) => string | null;
	cloned: boolean;
}

/** Open PRs (drafts included — gh pr list's default) for one repo. Throws on gh failure. */
export async function listRepoPullRequests(
	nameWithOwner: string,
	cwd: string,
	deps: RepoPullDeps,
): Promise<DashboardPullRequest[]> {
	const stdout = await gh(
		[
			"pr",
			"list",
			"--repo",
			nameWithOwner,
			"--state",
			"open",
			"--limit",
			String(PR_LIST_LIMIT),
			"--json",
			"number,title,url,author,isDraft,updatedAt",
		],
		cwd,
	);
	const prs = z.array(GhPrSchema).parse(JSON.parse(stdout));
	return prs.map((pr) => ({
		number: pr.number,
		title: pr.title,
		url: pr.url,
		repository: nameWithOwner,
		author: pr.author?.login ?? null,
		isDraft: pr.isDraft,
		updatedAt: pr.updatedAt,
		runId: deps.runIdFor(nameWithOwner, pr.number),
		cloned: deps.cloned,
	}));
}
