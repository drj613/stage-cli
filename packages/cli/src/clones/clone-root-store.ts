import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { type CloneRootRow, cloneRoot } from "../db/schema/index.js";

export function listCloneRoots(db: StageDb): CloneRootRow[] {
	return db.select().from(cloneRoot).orderBy(asc(cloneRoot.addedAt)).all();
}

/**
 * Register a search root. Validated at this boundary — a typo'd root silently
 * yielding zero repos is worse than failing loudly on add.
 */
export function addCloneRoot(db: StageDb, rootPath: string): void {
	if (!path.isAbsolute(rootPath)) {
		throw new Error(`Clone root must be an absolute path: ${rootPath}`);
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(rootPath);
	} catch {
		throw new Error(`Clone root does not exist: ${rootPath}`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`Clone root is not a directory: ${rootPath}`);
	}
	db.insert(cloneRoot).values({ path: rootPath }).onConflictDoNothing().run();
}

export function removeCloneRoot(db: StageDb, rootPath: string): void {
	db.delete(cloneRoot).where(eq(cloneRoot.path, rootPath)).run();
}
