import type { GenerateAccepted, GenerationJob } from "@stagereview/types/generation";
import { z } from "zod";
import type { StageDb } from "../db/client.js";
import {
	GENERATION_MODEL,
	type GenerationModel,
	type JobManager,
} from "../generation/job-manager.js";
import { parsePullRequestUrl, toNameWithOwner, toPullRequestUrl } from "../github/index.js";
import { RunIndex } from "../runs/run-index.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import { enforceSameOrigin } from "./pull-request-shared.js";

/**
 * Kick off and poll headless chapter generation for a PR. `defaultModel` is the
 * model requests fall back to when the body omits one — set from `--model` at
 * server startup; a request body's `model` always overrides it.
 */
export function generateRoutes(
	db: StageDb,
	jobs: JobManager,
	defaultModel: GenerationModel = GENERATION_MODEL.SONNET,
): Route[] {
	const generateInput = z.object({
		prUrl: z.string().url(),
		model: z.enum(GENERATION_MODEL).default(defaultModel),
	});
	return [
		{
			method: "POST",
			pattern: "/api/generate",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, generateInput);
				if (!body) return;
				const location = parsePullRequestUrl(body.prUrl);
				if (!location) {
					writeJson(res, 400, {
						error: `Not a github.com pull request URL: ${body.prUrl}`,
					});
					return;
				}
				// Stage generates only for repos it already has a clone path for; it never clones.
				const nameWithOwner = toNameWithOwner(location);
				const repoRoot = RunIndex.load(db).repoRootFor(nameWithOwner);
				if (!repoRoot) {
					writeJson(res, 422, {
						error: `No local clone known for ${nameWithOwner}. Run /stage-chapters once from a clone of it first.`,
					});
					return;
				}
				// Jobs carry the canonical URL so `/pull/7`, `/pull/7/files`, and
				// `/pull/7?diff=split` are one PR: a second request for a PR that's
				// already generating reuses the job in flight, and one agent session
				// runs no matter how many tabs ask.
				const prUrl = toPullRequestUrl(location);
				const active = jobs.activeJobFor(prUrl);
				const jobId = active ? active.id : jobs.enqueue({ prUrl, repoRoot, model: body.model });
				writeJson(res, 202, { jobId } satisfies GenerateAccepted);
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
				const { id, status, runId, error } = job;
				writeJson(res, 200, { id, status, runId, error } satisfies GenerationJob);
			},
		},
	];
}
