import { JOB_STATUS } from "@stagereview/types/generation";
import { PR_RESOLUTION, type PrResolution } from "@stagereview/types/pull-requests";
import type { StackChain, StackResponse } from "@stagereview/types/stacks";
import type { CloneRegistry } from "../clones/clone-registry.js";
import type { StageDb } from "../db/client.js";
import type { JobManager } from "../generation/job-manager.js";
import { ghErrorMessage } from "../github/exec.js";
import { liveHeadSha as defaultLiveHeadSha } from "../github/live-head.js";
import { buildStackGraph } from "../github/stack-index.js";
import {
	listStackPullRequests as defaultListPullRequests,
	type StackListResult,
} from "../github/stack-list.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";
import { parseNumber } from "./pull-request-shared.js";
import { findStackRun, movedMembers } from "./stack-resolve.js";

export interface StackRouteDeps {
	listPullRequests: (nameWithOwner: string, cwd: string) => Promise<StackListResult>;
	liveHeadSha: (nameWithOwner: string, prNumber: number) => Promise<string>;
}

const DEFAULT_DEPS: StackRouteDeps = {
	listPullRequests: defaultListPullRequests,
	liveHeadSha: defaultLiveHeadSha,
};

/** A chain always has at least two members, so its tip always exists. */
function tipOf(chain: StackChain): number {
	const tip = chain.members[chain.members.length - 1];
	if (!tip) throw new Error("chain has no members");
	return tip.number;
}

/**
 * Read every member's live head. A member whose head cannot be read is left out
 * rather than reported as moved — being offline should not make a stored run
 * look stale, matching how the single-PR resolver degrades.
 */
async function readLiveHeads(
	deps: StackRouteDeps,
	nameWithOwner: string,
	prNumbers: readonly number[],
): Promise<Map<number, string>> {
	const heads = new Map<number, string>();
	await Promise.all(
		prNumbers.map(async (prNumber) => {
			try {
				heads.set(prNumber, await deps.liveHeadSha(nameWithOwner, prNumber));
			} catch {
				// Offline or gh missing — the stored run is still viewable.
			}
		}),
	);
	return heads;
}

/**
 * Chain discovery plus chain resolution — how the dashboard turns a stack into a
 * viewable run. A `gh` failure on the graph is reported as unavailable rather
 * than an error status: badges are an enhancement to a list that has already
 * rendered, so failing loudly there would be noise the user cannot act on.
 */
export function stackRoutes(
	db: StageDb,
	jobs: JobManager,
	registry: CloneRegistry,
	deps: StackRouteDeps = DEFAULT_DEPS,
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
		{
			method: "GET",
			pattern: "/api/stacks/:owner/:repo/:number/resolve",
			handler: async (_req, res, params) => {
				const { owner, repo } = params;
				const number = parseNumber(params.number ?? null);
				if (!owner || !repo || number === null) {
					writeJson(res, 400, {
						error: "Expected /api/stacks/:owner/:repo/:number/resolve",
					});
					return;
				}
				const nameWithOwner = `${owner}/${repo}`;

				let chain: StackChain | undefined;
				try {
					const { prs, capped } = await deps.listPullRequests(nameWithOwner, process.cwd());
					// A chain is named by its tip, so only a tip resolves. Asking for a
					// middle PR is ambiguous above a fork, and this route refuses rather
					// than picking a branch for the user.
					chain = buildStackGraph(prs, capped).chains.find((c) => tipOf(c) === number);
				} catch (err) {
					writeJson(res, 502, { error: ghErrorMessage(err) });
					return;
				}
				if (!chain) {
					writeJson(res, 404, {
						error: `No stack in ${nameWithOwner} ends at #${number}`,
					});
					return;
				}

				const prUrls = chain.members.map((m) => m.url);
				const active = jobs.activeJobFor(prUrls);
				if (active) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.GENERATING,
						jobId: active.id,
					} satisfies PrResolution);
					return;
				}

				const prNumbers = chain.members.map((m) => m.number);
				const run = findStackRun(db, nameWithOwner, prNumbers);
				if (run) {
					const liveHeads = await readLiveHeads(deps, nameWithOwner, prNumbers);
					const moved = movedMembers(run.members, liveHeads);
					if (moved.length > 0) {
						writeJson(res, 200, {
							state: PR_RESOLUTION.STALE,
							runId: run.runId,
							movedPrNumbers: moved,
						} satisfies PrResolution);
						return;
					}
					writeJson(res, 200, {
						state: PR_RESOLUTION.READY,
						runId: run.runId,
					} satisfies PrResolution);
					return;
				}

				const latest = jobs.latestJobFor(prUrls);
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
