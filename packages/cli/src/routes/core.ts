import type { GenerationModel } from "@stagereview/types/generation";
import { CloneRegistry } from "../clones/clone-registry.js";
import type { StageDb } from "../db/client.js";
import { claudeRunner, JobManager } from "../generation/job-manager.js";
import type { Route } from "../server.js";
import { browseRoutes } from "./browse.js";
import { cloneRootRoutes } from "./clone-roots.js";
import { commentRoutes } from "./comments.js";
import { diffRoutes } from "./diff.js";
import { generateRoutes } from "./generate.js";
import { gitHubThreadRoutes } from "./github-threads.js";
import { pullRequestRoutes } from "./pull-request.js";
import { pullRequestMutationRoutes } from "./pull-request-mutations.js";
import { pullRequestListRoutes } from "./pull-requests.js";
import { runRoutes } from "./runs.js";
import { viewStateRoutes } from "./view-state.js";
import { viewerRoutes } from "./viewer.js";

/**
 * The full route set shared by both `stagereview show` and `stagereview start` —
 * past-run viewing/review, PR browsing, clone-root management, and
 * headless-generation endpoints. Each call gets its own `JobManager` and
 * `CloneRegistry`, since generation jobs and the clone scan are both
 * per server process, not shared across them.
 */
export function coreRoutes(db: StageDb, defaultModel: GenerationModel): Route[] {
	const jobs = new JobManager(claudeRunner);
	const registry = CloneRegistry.create(db);
	return [
		...runRoutes(db),
		...viewStateRoutes(db),
		...commentRoutes(db),
		...viewerRoutes(),
		...diffRoutes(db),
		...pullRequestRoutes(db),
		...pullRequestMutationRoutes(db),
		...gitHubThreadRoutes(db),
		...pullRequestListRoutes(db, jobs, registry),
		...browseRoutes(db, registry),
		...cloneRootRoutes(db, registry),
		...generateRoutes(jobs, registry, defaultModel),
	];
}
