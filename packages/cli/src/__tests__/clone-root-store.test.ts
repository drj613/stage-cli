import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCloneRoot, listCloneRoots, removeCloneRoot } from "../clones/clone-root-store.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";

let tmpDir = "";
let db: StageDb;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-clone-roots-"));
	closeDb();
	db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
});

afterEach(async () => {
	closeDb();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("clone-root-store", () => {
	it("round-trips add, list, and remove", async () => {
		const root = path.join(tmpDir, "code");
		await fs.mkdir(root);
		addCloneRoot(db, root);
		expect(listCloneRoots(db).map((r) => r.path)).toEqual([root]);
		removeCloneRoot(db, root);
		expect(listCloneRoots(db)).toEqual([]);
	});

	it("is idempotent when the same root is added twice", async () => {
		const root = path.join(tmpDir, "code");
		await fs.mkdir(root);
		addCloneRoot(db, root);
		addCloneRoot(db, root);
		expect(listCloneRoots(db)).toHaveLength(1);
	});

	it("rejects relative paths", () => {
		expect(() => addCloneRoot(db, "code")).toThrow(/absolute/);
	});

	it("rejects paths that are not directories", async () => {
		const file = path.join(tmpDir, "a-file");
		await fs.writeFile(file, "");
		expect(() => addCloneRoot(db, file)).toThrow(/not a directory/);
	});

	it("rejects paths that do not exist", () => {
		expect(() => addCloneRoot(db, path.join(tmpDir, "missing"))).toThrow(/does not exist/);
	});
});
