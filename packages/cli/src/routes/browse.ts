import type {
	OwnerReposResponse,
	OwnersResponse,
	RepoPullsResponse,
} from "@stagereview/types/browse";
import type { CloneRegistry } from "../clones/clone-registry.js";
import type { StageDb } from "../db/client.js";
import { ghErrorMessage } from "../github/exec.js";
import { listRepoPullRequests } from "../github/pr-list.js";
import { toNameWithOwner } from "../github/repo.js";
import { listOrgRepos } from "../github/repos.js";
import { RunIndex } from "../runs/run-index.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";

/** Owner → repo → PR browse endpoints, backed by the clone registry and `gh`. */
export function browseRoutes(db: StageDb, registry: CloneRegistry): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/owners",
			handler: (_req, res) => {
				writeJson(res, 200, { owners: registry.owners() } satisfies OwnersResponse);
			},
		},
		{
			method: "GET",
			pattern: "/api/owners/:owner/repos",
			handler: async (_req, res, params) => {
				const owner = params.owner;
				if (!owner) {
					writeJson(res, 400, { error: "Missing owner" });
					return;
				}
				try {
					const repos = await listOrgRepos(owner, process.cwd(), (name) => registry.isCloned(name));
					writeJson(res, 200, { available: true, repos } satisfies OwnerReposResponse);
				} catch (err) {
					writeJson(res, 200, {
						available: false,
						reason: ghErrorMessage(err),
					} satisfies OwnerReposResponse);
				}
			},
		},
		{
			method: "GET",
			pattern: "/api/repos/:owner/:repo/pulls",
			handler: async (_req, res, params) => {
				const { owner, repo } = params;
				if (!owner || !repo) {
					writeJson(res, 400, { error: "Missing owner or repo" });
					return;
				}
				const nameWithOwner = toNameWithOwner({ owner, repo });
				const index = RunIndex.load(db);
				try {
					const pullRequests = await listRepoPullRequests(nameWithOwner, process.cwd(), {
						runIdFor: (r, n) => index.singlePrRunIdFor(r, n),
						cloned: registry.isCloned(nameWithOwner),
					});
					writeJson(res, 200, { available: true, pullRequests } satisfies RepoPullsResponse);
				} catch (err) {
					writeJson(res, 200, {
						available: false,
						reason: ghErrorMessage(err),
					} satisfies RepoPullsResponse);
				}
			},
		},
	];
}
