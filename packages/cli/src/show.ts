import open from "open";
import { buildChaptersFile } from "./build-chapters-file.js";
import { closeDb, getDb } from "./db/client.js";
import { readRepoContext } from "./git.js";
import { coreRoutes } from "./routes/core.js";
import { insertChaptersFile } from "./runs/import-chapters.js";
import type { DiffScopeOptions } from "./scope.js";
import { LOOPBACK_HOST, startServer, waitForShutdownSignal } from "./server.js";

export async function show(jsonPath: string, options: DiffScopeOptions): Promise<void> {
	const db = getDb();
	const { chaptersFile, prNumber } = await buildChaptersFile(jsonPath, options);
	const { runId } = insertChaptersFile(db, chaptersFile, readRepoContext(), prNumber);

	const handle = await startServer({
		routes: coreRoutes(db),
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
