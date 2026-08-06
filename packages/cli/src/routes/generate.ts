import { GenerateRequestSchema } from "@stagereview/types/generate";
import {
	type ActiveGenerationJobs,
	GENERATION_MODEL,
	type GenerateAccepted,
	type GenerationModel,
} from "@stagereview/types/generation";
import type { CloneRegistry } from "../clones/clone-registry.js";
import { type JobManager, toWireJob } from "../generation/job-manager.js";
import { parsePullRequestUrl, toNameWithOwner, toPullRequestUrl } from "../github/index.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import { enforceSameOrigin } from "./pull-request-shared.js";

/**
 * Kick off and poll headless chapter generation for a PR or a stack of them.
 * `defaultModel` is the model requests fall back to when the body omits one —
 * set from `--model` at server startup; a request body's `model` always wins.
 */
export function generateRoutes(
	jobs: JobManager,
	registry: CloneRegistry,
	defaultModel: GenerationModel = GENERATION_MODEL.SONNET,
): Route[] {
	return [
		{
			method: "POST",
			pattern: "/api/generate",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, GenerateRequestSchema);
				if (!body) return;

				const locations = body.prUrls.map((url) => parsePullRequestUrl(url));
				const badIndex = locations.findIndex((l) => l === null);
				if (badIndex >= 0) {
					writeJson(res, 400, {
						error: `Not a github.com pull request URL: ${body.prUrls[badIndex]}`,
					});
					return;
				}
				const resolved = locations.flatMap((l) => (l === null ? [] : [l]));
				const first = resolved[0];
				if (first === undefined) {
					writeJson(res, 400, { error: "Expected at least one pull request URL" });
					return;
				}

				// Stage generates only for repos it already has a clone path for; it never clones.
				const nameWithOwner = toNameWithOwner(first);
				if (resolved.some((l) => toNameWithOwner(l) !== nameWithOwner)) {
					writeJson(res, 400, { error: "A stack must live in one repository" });
					return;
				}
				const repoRoot = registry.resolveRepoRoot(nameWithOwner);
				if (!repoRoot) {
					writeJson(res, 422, {
						error: `No local clone known for ${nameWithOwner}. Run \`stagereview config add-root <path>\`, add a search root in the dashboard's Settings, or clone the repo first.`,
					});
					return;
				}

				// Jobs carry canonical URLs so `/pull/7`, `/pull/7/files`, and
				// `/pull/7?diff=split` are one PR: a second request for work already
				// generating reuses the job in flight, and one agent session runs no
				// matter how many tabs ask. Sorting by number means the caller's
				// argument order cannot split one stack into two jobs — the real
				// stack order is established by ancestry, later, in the runner.
				const prUrls = [...resolved]
					.sort((a, b) => a.number - b.number)
					.map((location) => toPullRequestUrl(location));
				const active = jobs.activeJobFor(prUrls);
				const jobId = active
					? active.id
					: jobs.enqueue({ prUrls, repoRoot, requestedModel: body.model ?? defaultModel });
				writeJson(res, 202, { jobId } satisfies GenerateAccepted);
			},
		},
		{
			method: "GET",
			pattern: "/api/generate",
			handler: (_req, res) => {
				writeJson(res, 200, { jobs: jobs.activeJobs() } satisfies ActiveGenerationJobs);
			},
		},
		{
			method: "GET",
			pattern: "/api/generate/:jobId",
			handler: (_req, res, params) => {
				const jobId = params.jobId;
				const job = jobId ? jobs.get(jobId) : null;
				if (!job) {
					writeJson(res, 404, { error: "Job not found" });
					return;
				}
				writeJson(res, 200, toWireJob(job));
			},
		},
	];
}
