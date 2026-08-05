import type { GenerationModel } from "@stagereview/types/generation";
import open from "open";
import { closeDb, getDb } from "./db/client.js";
import { coreRoutes } from "./routes/core.js";
import { LOOPBACK_HOST, startServer, waitForShutdownSignal } from "./server.js";

export interface StartOptions {
	open: boolean;
	model: GenerationModel;
}

export async function start(options: StartOptions): Promise<void> {
	const db = getDb();

	const handle = await startServer({
		routes: coreRoutes(db, options.model),
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
