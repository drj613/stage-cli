import { describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { RunIndex } from "../runs/run-index.js";
import { makeFixture, makeRepoContext } from "./fixtures.js";
import { setupRunRoutesTest } from "./runs-route-harness.js";

const env = setupRunRoutesTest("stage-cli-run-index-");

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("RunIndex", () => {
	it("finds a single-PR run for its PR", () => {
		const db = getDb({ dbPath: env.dbPath });
		const repo = makeRepoContext({ originUrl: "git@github.com:acme/app.git" });
		const { runId } = insertChaptersFile(db, makeFixture(), repo, [{ prNumber: 12, headSha: A }]);
		expect(RunIndex.load(db).singlePrRunIdFor("acme/app", 12)).toBe(runId);
	});

	it("finds a run for a mixed-case repository", () => {
		const db = getDb({ dbPath: env.dbPath });
		const repo = makeRepoContext({ originUrl: "git@github.com:Acme/App.git" });
		const { runId } = insertChaptersFile(db, makeFixture(), repo, [{ prNumber: 12, headSha: A }]);
		expect(RunIndex.load(db).singlePrRunIdFor("acme/app", 12)).toBe(runId);
	});

	it("does not offer a stack run as the run for one of its members", () => {
		const db = getDb({ dbPath: env.dbPath });
		const repo = makeRepoContext({ originUrl: "git@github.com:acme/app.git" });
		insertChaptersFile(db, makeFixture(), repo, [
			{ prNumber: 12, headSha: A },
			{ prNumber: 13, headSha: B },
		]);
		const index = RunIndex.load(db);
		expect(index.singlePrRunIdFor("acme/app", 12)).toBeNull();
		expect(index.singlePrRunIdFor("acme/app", 13)).toBeNull();
	});

	it("still learns a repo root from a stack run", () => {
		const db = getDb({ dbPath: env.dbPath });
		const repo = makeRepoContext({ originUrl: "git@github.com:acme/app.git" });
		insertChaptersFile(db, makeFixture(), repo, [
			{ prNumber: 12, headSha: A },
			{ prNumber: 13, headSha: B },
		]);
		expect(RunIndex.load(db).repoRootFor("acme/app")).toBe("/repo");
	});

	it("reports no run for a PR nothing has been generated for", () => {
		const db = getDb({ dbPath: env.dbPath });
		expect(RunIndex.load(db).singlePrRunIdFor("acme/app", 99)).toBeNull();
	});
});
