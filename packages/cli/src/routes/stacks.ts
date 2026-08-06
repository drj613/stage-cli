import type { StackResponse } from "@stagereview/types/stacks";
import { ghErrorMessage } from "../github/exec.js";
import { buildStackGraph } from "../github/stack-index.js";
import {
	listStackPullRequests as defaultListPullRequests,
	type StackListResult,
} from "../github/stack-list.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";

export interface StackRouteDeps {
	listPullRequests: (nameWithOwner: string, cwd: string) => Promise<StackListResult>;
}

/**
 * The chain graph for one repo. A `gh` failure is reported as unavailable rather
 * than an error status: badges are an enhancement to a list that has already
 * rendered, so failing loudly here would be noise the user cannot act on.
 */
export function stackRoutes(
	deps: StackRouteDeps = { listPullRequests: defaultListPullRequests },
): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/stacks/:owner/:repo",
			handler: async (_req, res, params) => {
				const { owner, repo } = params;
				if (!owner || !repo) {
					writeJson(res, 400, { error: "Expected /api/stacks/:owner/:repo" });
					return;
				}
				try {
					const { prs, capped } = await deps.listPullRequests(`${owner}/${repo}`, process.cwd());
					writeJson(res, 200, {
						available: true,
						graph: buildStackGraph(prs, capped),
					} satisfies StackResponse);
				} catch (err) {
					writeJson(res, 200, {
						available: false,
						reason: ghErrorMessage(err),
					} satisfies StackResponse);
				}
			},
		},
	];
}
