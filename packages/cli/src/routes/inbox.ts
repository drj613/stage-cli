import type { InboxResponse } from "@stagereview/types/inbox";
import { desc } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { ghErrorMessage } from "../github/exec.js";
import { mapSearchResults, searchReviewRequested } from "../github/inbox.js";
import { parseGitHubRepo, toNameWithOwner } from "../github/repo.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";

/**
 * Newest chapter run per (owner/repo, PR number), so the inbox can link a PR
 * straight to its most recent review instead of always starting a fresh one.
 * Rows are read newest-generated-first, so the first run seen per PR wins.
 */
function buildRunIdLookup(db: StageDb): (repo: string, prNumber: number) => string | null {
	const runs = db
		.select({
			id: chapterRun.id,
			originUrl: chapterRun.originUrl,
			prNumber: chapterRun.prNumber,
			generatedAt: chapterRun.generatedAt,
		})
		.from(chapterRun)
		.orderBy(desc(chapterRun.generatedAt))
		.all();

	const byRepo = new Map<string, Map<number, string>>();
	for (const run of runs) {
		if (run.prNumber === null) continue;
		const repo = parseGitHubRepo(run.originUrl);
		if (!repo) continue;
		const nameWithOwner = toNameWithOwner(repo);
		let byPrNumber = byRepo.get(nameWithOwner);
		if (!byPrNumber) {
			byPrNumber = new Map();
			byRepo.set(nameWithOwner, byPrNumber);
		}
		if (!byPrNumber.has(run.prNumber)) byPrNumber.set(run.prNumber, run.id);
	}

	return (repo, prNumber) => byRepo.get(repo.toLowerCase())?.get(prNumber) ?? null;
}

/** Cross-org PR inbox backed by `gh search prs`. */
export function inboxRoutes(db: StageDb): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/inbox",
			handler: async (_req, res) => {
				let raw: unknown[];
				try {
					raw = await searchReviewRequested(process.cwd());
				} catch (err) {
					writeJson(res, 200, {
						available: false,
						reason: ghErrorMessage(err),
					} satisfies InboxResponse);
					return;
				}
				const runIdFor = buildRunIdLookup(db);
				writeJson(res, 200, {
					available: true,
					pullRequests: mapSearchResults(raw, runIdFor),
				} satisfies InboxResponse);
			},
		},
	];
}
