import { JOB_STATUS } from "@stagereview/types/generation";
import type { PrResolution, PullRequestListResponse } from "@stagereview/types/pull-requests";
import { PR_FILTER, PR_RESOLUTION } from "@stagereview/types/pull-requests";
import { z } from "zod";
import type { CloneRegistry } from "../clones/clone-registry.js";
import type { StageDb } from "../db/client.js";
import type { JobManager } from "../generation/job-manager.js";
import { ghErrorMessage } from "../github/exec.js";
import { toNameWithOwner, toPullRequestUrl } from "../github/index.js";
import { liveHeadSha as defaultLiveHeadSha } from "../github/live-head.js";
import { mapSearchResults, searchPullRequests } from "../github/pr-search.js";
import { RunIndex } from "../runs/run-index.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";
import { parseNumber, query } from "./pull-request-shared.js";

export interface PullRequestRouteDeps {
	liveHeadSha: (nameWithOwner: string, prNumber: number) => Promise<string>;
}

const FilterSchema = z.enum(PR_FILTER);

/** PR list search plus PR resolution — how the dashboard turns a PR into a viewable run. */
export function pullRequestListRoutes(
	db: StageDb,
	jobs: JobManager,
	registry: CloneRegistry,
	deps: PullRequestRouteDeps = { liveHeadSha: defaultLiveHeadSha },
): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/pull-requests",
			handler: async (req, res) => {
				const parsed = FilterSchema.safeParse(query(req, "filter"));
				if (!parsed.success) {
					writeJson(res, 400, {
						error: "Unknown filter. Expected review-requested, assignee, or author.",
					});
					return;
				}
				let raw: unknown[];
				try {
					raw = await searchPullRequests(parsed.data, process.cwd());
				} catch (err) {
					writeJson(res, 200, {
						available: false,
						reason: ghErrorMessage(err),
					} satisfies PullRequestListResponse);
					return;
				}
				const index = RunIndex.load(db);
				writeJson(res, 200, {
					available: true,
					pullRequests: mapSearchResults(raw, {
						runIdFor: (repo, prNumber) => index.singlePrRunIdFor(repo, prNumber),
						isCloned: (repo) => registry.isCloned(repo),
					}),
				} satisfies PullRequestListResponse);
			},
		},
		{
			method: "GET",
			pattern: "/api/pull-requests/:owner/:repo/:number",
			handler: async (_req, res, params) => {
				const number = parseNumber(params.number ?? null);
				const { owner, repo } = params;
				if (!owner || !repo || number === null) {
					writeJson(res, 400, { error: "Expected /api/pull-requests/:owner/:repo/:number" });
					return;
				}
				const location = { owner, repo, number };
				const nameWithOwner = toNameWithOwner(location);
				const prUrl = toPullRequestUrl(location);

				const active = jobs.activeJobFor([prUrl]);
				if (active) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.GENERATING,
						jobId: active.id,
					} satisfies PrResolution);
					return;
				}

				const run = RunIndex.load(db).latestSinglePrRunFor(nameWithOwner, number);
				if (run) {
					let liveHead: string | null = null;
					try {
						liveHead = await deps.liveHeadSha(nameWithOwner, number);
					} catch {
						// Offline or gh missing — the stored run is still viewable, so
						// report ready rather than blocking the bookmark on a network call.
					}
					if (liveHead !== null && liveHead !== run.headSha) {
						writeJson(res, 200, {
							state: PR_RESOLUTION.STALE,
							runId: run.runId,
							movedPrNumbers: [number],
						} satisfies PrResolution);
						return;
					}
					writeJson(res, 200, {
						state: PR_RESOLUTION.READY,
						runId: run.runId,
					} satisfies PrResolution);
					return;
				}

				const latest = jobs.latestJobFor([prUrl]);
				if (latest?.status === JOB_STATUS.FAILED) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.FAILED,
						jobId: latest.id,
						error: latest.error ?? "Generation failed",
					} satisfies PrResolution);
					return;
				}

				if (registry.resolveRepoRoot(nameWithOwner) === null) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.NO_CLONE,
						nameWithOwner,
					} satisfies PrResolution);
					return;
				}
				writeJson(res, 200, { state: PR_RESOLUTION.NEEDS_GENERATION } satisfies PrResolution);
			},
		},
	];
}
