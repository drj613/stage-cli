import type { StageDb } from "../db/client.js";
import type { Route } from "../server.js";
import { commentRoutes } from "./comments.js";
import { diffRoutes } from "./diff.js";
import { gitHubThreadRoutes } from "./github-threads.js";
import { pullRequestRoutes } from "./pull-request.js";
import { pullRequestMutationRoutes } from "./pull-request-mutations.js";
import { runRoutes } from "./runs.js";
import { viewStateRoutes } from "./view-state.js";
import { viewerRoutes } from "./viewer.js";

/** The route set shared by both `stagereview show` and `stagereview start`. */
export function coreRoutes(db: StageDb): Route[] {
	return [
		...runRoutes(db),
		...viewStateRoutes(db),
		...commentRoutes(db),
		...viewerRoutes(),
		...diffRoutes(db),
		...pullRequestRoutes(db),
		...pullRequestMutationRoutes(db),
		...gitHubThreadRoutes(db),
	];
}
