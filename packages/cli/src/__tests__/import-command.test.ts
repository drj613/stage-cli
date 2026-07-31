import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { runImport } from "../import.js";
import { makeFixture } from "./fixtures.js";

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cli-import-command-"));
	dbPath = path.join(tmpDir, "db.sqlite");
	closeDb();
});

afterEach(async () => {
	closeDb();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runImport", () => {
	it("inserts a run and returns the runId without serving or opening a browser", async () => {
		const db = getDb({ dbPath });
		const fixture = makeFixture();
		const fixturePath = path.join(tmpDir, "chapters.json");
		await fs.writeFile(fixturePath, JSON.stringify(fixture));

		const before = db.select().from(chapterRun).all().length;

		const runId = await runImport(fixturePath, {}, db);

		const after = db.select().from(chapterRun).all();
		expect(after.length).toBe(before + 1);
		expect(runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(after.find((row) => row.id === runId)).toBeDefined();
	});
});
