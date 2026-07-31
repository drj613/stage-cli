import open from "open";
import { closeDb, getDb } from "./db/client.js";
import { commentRoutes } from "./routes/comments.js";
import { diffRoutes } from "./routes/diff.js";
import { gitHubThreadRoutes } from "./routes/github-threads.js";
import { pullRequestRoutes } from "./routes/pull-request.js";
import { pullRequestMutationRoutes } from "./routes/pull-request-mutations.js";
import { runRoutes } from "./routes/runs.js";
import { viewStateRoutes } from "./routes/view-state.js";
import { viewerRoutes } from "./routes/viewer.js";
import { LOOPBACK_HOST, startServer, waitForShutdownSignal } from "./server.js";

export interface StartOptions {
	open: boolean;
}

export async function start(options: StartOptions): Promise<void> {
	const db = getDb();

	const handle = await startServer({
		routes: [
			...runRoutes(db),
			...viewStateRoutes(db),
			...commentRoutes(db),
			...viewerRoutes(),
			...diffRoutes(db),
			...pullRequestRoutes(db),
			...pullRequestMutationRoutes(db),
			...gitHubThreadRoutes(db),
		],
	});
	const { port } = handle;
	const url = `http://${LOOPBACK_HOST}:${port}/`;

	process.stdout.write(`Stage dashboard on ${url}\n`);
	process.stdout.write("Press Ctrl+C to exit.\n");

	if (options.open) {
		try {
			await open(url);
		} catch {
			// URL is on stdout — user can navigate manually.
		}
	}

	await waitForShutdownSignal();

	await handle.close();
	closeDb();
}
