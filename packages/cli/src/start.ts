import open from "open";
import { closeDb, getDb } from "./db/client.js";
import { claudeRunner, JobManager } from "./generation/job-manager.js";
import { coreRoutes } from "./routes/core.js";
import { generateRoutes } from "./routes/generate.js";
import { inboxRoutes } from "./routes/inbox.js";
import { LOOPBACK_HOST, startServer, waitForShutdownSignal } from "./server.js";

export interface StartOptions {
	open: boolean;
}

export async function start(options: StartOptions): Promise<void> {
	const db = getDb();

	const jobs = new JobManager(claudeRunner);

	const handle = await startServer({
		routes: [...coreRoutes(db), ...inboxRoutes(db), ...generateRoutes(db, jobs)],
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
