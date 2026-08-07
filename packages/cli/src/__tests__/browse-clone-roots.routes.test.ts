import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneRegistry } from "../clones/clone-registry.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";
import { chapterRun, cloneRoot } from "../db/schema/index.js";
import { browseRoutes } from "../routes/browse.js";
import { cloneRootRoutes } from "../routes/clone-roots.js";
import { SCOPE_KIND } from "../schema.js";
import { type ServerHandle, startServer } from "../server.js";
import { writeCloneConfig } from "./fixtures.js";
import { requestJson } from "./runs-route-harness.js";

const SHA = "a".repeat(40);

describe("browse and clone-roots routes", () => {
	let tmpDir = "";
	let db: StageDb;
	let handle: ServerHandle | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-browse-clone-roots-"));
		closeDb();
		db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
	});

	afterEach(async () => {
		await handle?.close();
		handle = null;
		closeDb();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	/** Registers a fake local clone by seeding a chapter_run with a GitHub origin. */
	async function makeClone(originUrl: string, repoRoot: string): Promise<void> {
		await writeCloneConfig(repoRoot, originUrl);
		db.insert(chapterRun)
			.values({
				repoRoot,
				originUrl,
				scopeKind: SCOPE_KIND.COMMITTED,
				workingTreeRef: null,
				baseSha: SHA,
				headSha: SHA,
				mergeBaseSha: SHA,
				generatedAt: new Date(),
			})
			.run();
	}

	async function start(registry: CloneRegistry): Promise<number> {
		handle = await startServer({
			routes: [...browseRoutes(db, registry), ...cloneRootRoutes(db, registry)],
		});
		return handle.port;
	}

	it("GET /api/owners returns owners with clone counts from the index", async () => {
		const rootDir = path.join(tmpDir, "root");
		await makeClone("git@github.com:acme/widgets.git", path.join(rootDir, "widgets"));
		await makeClone("git@github.com:acme/gadgets.git", path.join(rootDir, "gadgets"));
		db.insert(cloneRoot).values({ path: rootDir }).run();
		const registry = CloneRegistry.create(db);
		const port = await start(registry);
		const res = await requestJson(port, "GET", "/api/owners");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ owners: [{ owner: "acme", cloneCount: 2 }] });
	});

	it("GET /api/clone-roots lists configured roots", async () => {
		const registry = CloneRegistry.create(db);
		const port = await start(registry);
		const res = await requestJson(port, "GET", "/api/clone-roots");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ roots: [] });
	});

	it("POST /api/clone-roots adds a root and triggers a rescan", async () => {
		const rootDir = path.join(tmpDir, "root");
		await makeClone("git@github.com:acme/widgets.git", path.join(rootDir, "widgets"));
		const registry = CloneRegistry.create(db);
		const port = await start(registry);
		const res = await requestJson(port, "POST", "/api/clone-roots", { path: rootDir });
		expect(res.status).toBe(200);
		expect(registry.owners()).toEqual([{ owner: "acme", cloneCount: 1 }]);
	});

	it("POST /api/clone-roots rejects a relative path with 400", async () => {
		const registry = CloneRegistry.create(db);
		const port = await start(registry);
		const res = await requestJson(port, "POST", "/api/clone-roots", { path: "relative/path" });
		expect(res.status).toBe(400);
	});

	it("POST /api/clone-roots enforces same-origin", async () => {
		const registry = CloneRegistry.create(db);
		const port = await start(registry);
		const res = await requestJson(
			port,
			"POST",
			"/api/clone-roots",
			{ path: path.join(tmpDir, "root") },
			{ Origin: "http://evil.example" },
		);
		expect(res.status).toBe(403);
	});

	it("DELETE /api/clone-roots removes a root and rescans", async () => {
		const rootDir = path.join(tmpDir, "root");
		await makeClone("git@github.com:acme/widgets.git", path.join(rootDir, "widgets"));
		db.insert(cloneRoot).values({ path: rootDir }).run();
		const registry = CloneRegistry.create(db);
		expect(registry.owners()).toEqual([{ owner: "acme", cloneCount: 1 }]);
		const port = await start(registry);
		const res = await requestJson(port, "DELETE", "/api/clone-roots", { path: rootDir });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ roots: [] });
		expect(registry.owners()).toEqual([]);
	});

	it("POST /api/clone-roots/rescan returns repo and owner counts", async () => {
		const rootDir = path.join(tmpDir, "root");
		await makeClone("git@github.com:acme/widgets.git", path.join(rootDir, "widgets"));
		db.insert(cloneRoot).values({ path: rootDir }).run();
		const registry = CloneRegistry.create(db);
		const port = await start(registry);
		const res = await requestJson(port, "POST", "/api/clone-roots/rescan");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ repoCount: 1, ownerCount: 1 });
	});
});
