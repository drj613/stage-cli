import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * The 0009 backfill is hand-written — `drizzle-kit generate` produces the table
 * and the column drop but never the `INSERT` that carries existing runs across.
 * Every other test starts from an empty database, so nothing else exercises it,
 * and getting it wrong silently detaches every existing run from its PR.
 *
 * The statement is read from the migration file rather than restated here, so
 * this fails if the real SQL drifts.
 */
const MIGRATION = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../drizzle/0009_friendly_calypso.sql",
);

function backfillStatement(): string {
	const statements = readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint");
	const insert = statements.find((s) => s.trim().toUpperCase().startsWith("INSERT"));
	if (!insert) throw new Error("0009 migration has no INSERT — the backfill is missing");
	return insert.trim();
}

/** The pre-0009 `chapter_run` shape, reduced to the columns the backfill reads. */
function seedOldSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE chapter_run (
			id text PRIMARY KEY NOT NULL,
			prNumber integer,
			headSha text NOT NULL
		);
		CREATE TABLE chapter_run_pull_request (
			runId text NOT NULL,
			prNumber integer NOT NULL,
			headSha text NOT NULL,
			position integer NOT NULL,
			PRIMARY KEY (runId, prNumber)
		);
	`);
}

describe("0009 backfill", () => {
	it("carries a PR run across as exactly one member and leaves local runs alone", () => {
		const db = new Database(":memory:");
		seedOldSchema(db);
		db.prepare("INSERT INTO chapter_run VALUES (?, ?, ?)").run("run-pr", 42, "a".repeat(40));
		db.prepare("INSERT INTO chapter_run VALUES (?, ?, ?)").run("run-local", null, "b".repeat(40));

		db.exec(backfillStatement());

		const rows = db
			.prepare("SELECT runId, prNumber, headSha, position FROM chapter_run_pull_request")
			.all();
		expect(rows).toEqual([{ runId: "run-pr", prNumber: 42, headSha: "a".repeat(40), position: 0 }]);
		db.close();
	});
});
