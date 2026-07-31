import { buildChaptersFile } from "./build-chapters-file.js";
import { closeDb, getDb, type StageDb } from "./db/client.js";
import { readRepoContext } from "./git.js";
import { insertChaptersFile } from "./runs/import-chapters.js";
import type { DiffScopeOptions } from "./scope.js";

/**
 * Insert a chapters file into the DB without serving it. Prints the runId so
 * headless generation (the dashboard's `claude -p` jobs) can hand the run back
 * to an already-running `stagereview start` server.
 */
export async function runImport(
	jsonPath: string,
	options: DiffScopeOptions,
	db: StageDb = getDb(),
): Promise<string> {
	const { chaptersFile, prNumber } = await buildChaptersFile(jsonPath, options);
	const { runId } = insertChaptersFile(db, chaptersFile, readRepoContext(), prNumber);
	closeDb();
	return runId;
}
