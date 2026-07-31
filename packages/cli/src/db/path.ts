import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const STAGE_HOME = ".stage";
const DB_FILE = "db.sqlite";

export function getDbPath(): string {
	const dir = path.join(homedir(), STAGE_HOME);
	mkdirSync(dir, { recursive: true });
	return path.join(dir, DB_FILE);
}
