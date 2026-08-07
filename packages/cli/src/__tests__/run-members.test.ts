import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { chapterRun, chapterRunPullRequest } from "../db/schema/index.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { listRunMembers } from "../runs/run-members.js";
import { makeFixture, makeRepoContext } from "./fixtures.js";
import { setupRunRoutesTest } from "./runs-route-harness.js";

const env = setupRunRoutesTest("stage-cli-members-");

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("run membership", () => {
	it("stores no members for a local run", () => {
		const db = getDb({ dbPath: env.dbPath });
		insertChaptersFile(db, makeFixture(), makeRepoContext());
		expect(db.select().from(chapterRunPullRequest).all()).toEqual([]);
	});

	it("stores one member per pull request in stack order", () => {
		const db = getDb({ dbPath: env.dbPath });
		const { runId } = insertChaptersFile(db, makeFixture(), makeRepoContext(), [
			{ prNumber: 12, headSha: A },
			{ prNumber: 13, headSha: B },
		]);
		expect(listRunMembers(db, runId)).toEqual([
			{ prNumber: 12, headSha: A, position: 0 },
			{ prNumber: 13, headSha: B, position: 1 },
		]);
	});

	it("drops members when the run is deleted", () => {
		const db = getDb({ dbPath: env.dbPath });
		const { runId } = insertChaptersFile(db, makeFixture(), makeRepoContext(), [
			{ prNumber: 12, headSha: A },
		]);
		db.delete(chapterRun).where(eq(chapterRun.id, runId)).run();
		expect(db.select().from(chapterRunPullRequest).all()).toEqual([]);
	});
});
