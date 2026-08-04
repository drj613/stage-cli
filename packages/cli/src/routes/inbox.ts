import type { InboxResponse } from "@stagereview/types/inbox";
import type { StageDb } from "../db/client.js";
import { ghErrorMessage } from "../github/exec.js";
import { mapSearchResults, searchReviewRequested } from "../github/inbox.js";
import { RunIndex } from "../runs/run-index.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";

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
				const index = RunIndex.load(db);
				writeJson(res, 200, {
					available: true,
					pullRequests: mapSearchResults(raw, (repo, prNumber) => index.runIdFor(repo, prNumber)),
				} satisfies InboxResponse);
			},
		},
	];
}
