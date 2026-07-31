import { desc } from "drizzle-orm";
import { z } from "zod";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { GENERATION_MODEL, type JobManager } from "../generation/job-manager.js";
import { parseGitHubRepo, toNameWithOwner } from "../github/repo.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import { enforceSameOrigin } from "./pull-request-shared.js";

const generateInput = z.object({
	prUrl: z.string().url(),
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repository must be owner/name"),
	model: z.enum(GENERATION_MODEL).default(GENERATION_MODEL.SONNET),
});

/**
 * Where a past run of `repository` was generated from. Stage only generates for
 * repos it already has a clone path for — it never clones anything itself.
 */
function findRepoRoot(db: StageDb, repository: string): string | null {
	const runs = db
		.select({ repoRoot: chapterRun.repoRoot, originUrl: chapterRun.originUrl })
		.from(chapterRun)
		.orderBy(desc(chapterRun.generatedAt))
		.all();
	const wanted = repository.toLowerCase();
	for (const run of runs) {
		const repo = parseGitHubRepo(run.originUrl);
		if (repo && toNameWithOwner(repo) === wanted) return run.repoRoot;
	}
	return null;
}

/** Kick off and poll headless chapter generation for a PR. */
export function generateRoutes(db: StageDb, jobs: JobManager): Route[] {
	return [
		{
			method: "POST",
			pattern: "/api/generate",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, generateInput);
				if (!body) return;
				const repoRoot = findRepoRoot(db, body.repository);
				if (!repoRoot) {
					writeJson(res, 422, {
						error: `No local clone known for ${body.repository}. Run /stage-chapters once from a clone of it first.`,
					});
					return;
				}
				const jobId = jobs.enqueue({ prUrl: body.prUrl, repoRoot, model: body.model });
				writeJson(res, 202, { jobId });
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
				writeJson(res, 200, {
					id: job.id,
					status: job.status,
					runId: job.runId,
					error: job.error,
				});
			},
		},
	];
}
