import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneRegistry } from "../clones/clone-registry.js";
import { addCloneRoot } from "../clones/clone-root-store.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { SCOPE_KIND } from "../schema.js";

let tmpDir = "";
let db: StageDb;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-clone-registry-"));
	closeDb();
	db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
});
afterEach(async () => {
	closeDb();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeClone(rel: string, originUrl: string): Promise<string> {
	const dir = path.join(tmpDir, rel);
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.writeFile(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${originUrl}\n`);
	return dir;
}

function seedRun(repoRoot: string, originUrl: string): void {
	db.insert(chapterRun)
		.values({
			repoRoot,
			originUrl,
			scopeKind: SCOPE_KIND.COMMITTED,
			workingTreeRef: null,
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			mergeBaseSha: "a".repeat(40),
			generatedAt: new Date(),
		})
		.run();
}

describe("CloneRegistry.resolveRepoRoot", () => {
	it("resolves through the clone index", async () => {
		const dir = await makeClone("roots/api", "git@github.com:acme/api.git");
		addCloneRoot(db, path.join(tmpDir, "roots"));
		const registry = CloneRegistry.create(db);
		expect(registry.resolveRepoRoot("acme/api")).toBe(dir);
	});

	it("falls back to RunIndex when the index has no entry", async () => {
		const dir = await makeClone("elsewhere/api", "git@github.com:acme/api.git");
		seedRun(dir, "git@github.com:acme/api.git");
		const registry = CloneRegistry.create(db); // no roots configured
		expect(registry.resolveRepoRoot("acme/api")).toBe(dir);
	});

	it("reports no clone when an indexed path has since lost its .git", async () => {
		const dir = await makeClone("roots/api", "git@github.com:acme/api.git");
		addCloneRoot(db, path.join(tmpDir, "roots"));
		const registry = CloneRegistry.create(db);
		await fs.rm(path.join(dir, ".git"), { recursive: true });
		expect(registry.resolveRepoRoot("acme/api")).toBeNull();
	});

	it("falls through to a valid RunIndex path when the indexed path is stale", async () => {
		const indexed = await makeClone("roots/api", "git@github.com:acme/api.git");
		const historical = await makeClone("elsewhere/api", "git@github.com:acme/api.git");
		seedRun(historical, "git@github.com:acme/api.git");
		addCloneRoot(db, path.join(tmpDir, "roots"));
		const registry = CloneRegistry.create(db);
		await fs.rm(path.join(indexed, ".git"), { recursive: true });
		expect(registry.resolveRepoRoot("acme/api")).toBe(historical);
	});

	it("reports no clone when a RunIndex path has since been removed", async () => {
		const dir = await makeClone("gone/api", "git@github.com:acme/api.git");
		seedRun(dir, "git@github.com:acme/api.git");
		const registry = CloneRegistry.create(db);
		await fs.rm(dir, { recursive: true });
		expect(registry.resolveRepoRoot("acme/api")).toBeNull();
	});

	it("rescan picks up a newly added clone", async () => {
		addCloneRoot(db, tmpDir);
		const registry = CloneRegistry.create(db);
		expect(registry.resolveRepoRoot("acme/late")).toBeNull();
		await makeClone("late", "git@github.com:acme/late.git");
		const summary = registry.rescan();
		expect(summary.repoCount).toBeGreaterThanOrEqual(1);
		expect(registry.resolveRepoRoot("acme/late")).not.toBeNull();
	});
});
