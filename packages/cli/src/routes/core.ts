import type { StageDb } from "../db/client.js";
import { claudeRunner, type GenerationModel, JobManager } from "../generation/job-manager.js";
import type { Route } from "../server.js";
import { commentRoutes } from "./comments.js";
import { diffRoutes } from "./diff.js";
import { generateRoutes } from "./generate.js";
import { gitHubThreadRoutes } from "./github-threads.js";
import { pullRequestRoutes } from "./pull-request.js";
import { pullRequestMutationRoutes } from "./pull-request-mutations.js";
import { runRoutes } from "./runs.js";
import { viewStateRoutes } from "./view-state.js";
import { viewerRoutes } from "./viewer.js";

/**
 * The full route set shared by both `stagereview show` and `stagereview start` —
 * past-run viewing/review plus the PR inbox and headless-generation endpoints.
 * Each call gets its own `JobManager`, since generation jobs are serialized
 * per server process, not shared across them.
 */
export function coreRoutes(db: StageDb, defaultModel: GenerationModel): Route[] {
	const jobs = new JobManager(claudeRunner);
	return [
		...runRoutes(db),
		...viewStateRoutes(db),
		...commentRoutes(db),
		...viewerRoutes(),
		...diffRoutes(db),
		...pullRequestRoutes(db),
		...pullRequestMutationRoutes(db),
		...gitHubThreadRoutes(db),
		...generateRoutes(db, jobs, defaultModel),
	];
}
