import { buildChaptersFile } from "./build-chapters-file.js";
import { getDb, type StageDb } from "./db/client.js";
import { readRepoContext } from "./git.js";
import { insertChaptersFile } from "./runs/import-chapters.js";
import type { DiffScopeOptions } from "./scope.js";

/**
 * Insert a chapters file into the DB without serving it. Prints the runId so
 * headless generation (the dashboard's `claude -p` jobs) can hand the run back
 * to an already-running `stagereview start` server. Caller owns the DB
 * lifecycle (closing it, if it opened it) — same convention as `show`.
 */
export async function runImport(
	jsonPath: string,
	options: DiffScopeOptions,
	db: StageDb = getDb(),
): Promise<string> {
	const { chaptersFile, members } = await buildChaptersFile(jsonPath, options);
	const { runId } = insertChaptersFile(db, chaptersFile, readRepoContext(options.cwd), members);
	return runId;
}
