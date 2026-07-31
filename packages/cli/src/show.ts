import open from "open";
import { buildChaptersFile } from "./build-chapters-file.js";
import { closeDb, getDb } from "./db/client.js";
import { readRepoContext } from "./git.js";
import { commentRoutes } from "./routes/comments.js";
import { diffRoutes } from "./routes/diff.js";
import { gitHubThreadRoutes } from "./routes/github-threads.js";
import { pullRequestRoutes } from "./routes/pull-request.js";
import { pullRequestMutationRoutes } from "./routes/pull-request-mutations.js";
import { runRoutes } from "./routes/runs.js";
import { viewStateRoutes } from "./routes/view-state.js";
import { viewerRoutes } from "./routes/viewer.js";
import { insertChaptersFile } from "./runs/import-chapters.js";
import type { DiffScopeOptions } from "./scope.js";
import { LOOPBACK_HOST, startServer } from "./server.js";

export async function show(jsonPath: string, options: DiffScopeOptions): Promise<void> {
	const db = getDb();
	const { chaptersFile, prNumber } = await buildChaptersFile(jsonPath, options);
	const { runId } = insertChaptersFile(db, chaptersFile, readRepoContext(), prNumber);

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
	const url = `http://${LOOPBACK_HOST}:${port}/runs/${encodeURIComponent(runId)}`;

	process.stdout.write(`Listening on ${url}\n`);
	process.stdout.write("Press Ctrl+C to exit.\n");

	try {
		await open(url);
	} catch {
		// URL is on stdout — user can navigate manually.
	}

	await waitForShutdownSignal();

	await handle.close();
	closeDb();
}

function waitForShutdownSignal(): Promise<void> {
	return new Promise<void>((resolve) => {
		const cleanup = () => {
			process.removeListener("SIGINT", cleanup);
			process.removeListener("SIGTERM", cleanup);
			resolve();
		};

		process.once("SIGINT", cleanup);
		process.once("SIGTERM", cleanup);
	});
}
