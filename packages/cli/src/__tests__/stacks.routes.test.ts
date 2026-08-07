import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneRegistry } from "../clones/clone-registry.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";
import { JobManager } from "../generation/job-manager.js";
import { type StackRouteDeps, stackRoutes } from "../routes/stacks.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { type ServerHandle, startServer } from "../server.js";
import { makeFixture, makeRepoContext, writeCloneConfig } from "./fixtures.js";
import { getJson } from "./runs-route-harness.js";

const ORIGIN_URL = "git@github.com:acme/app.git";
const A = "a".repeat(40);
const B = "b".repeat(40);

const row = (number: number, headRefName: string, baseRefName: string) => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/acme/app/pull/${number}`,
	isDraft: false,
	isCrossRepository: false,
	headRefName,
	baseRefName,
});

/** #12 → #13, the chain every resolve test works against. */
const CHAIN = [row(12, "a", "main"), row(13, "b", "a")];

describe("stack routes", () => {
	let tmpDir = "";
	let repoRoot = "";
	let db: StageDb;
	let jobs: JobManager;
	let handle: ServerHandle | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-stacks-"));
		repoRoot = path.join(tmpDir, "repo");
		closeDb();
		db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
		jobs = new JobManager(async () => "run-from-job");
	});

	afterEach(async () => {
		await handle?.close();
		handle = null;
		closeDb();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function start(deps: Partial<StackRouteDeps> = {}): Promise<number> {
		const registry = CloneRegistry.create(db);
		handle = await startServer({
			routes: stackRoutes(db, jobs, registry, {
				listPullRequests: async () => ({ prs: CHAIN, capped: false }),
				liveHeadSha: async () => {
					throw new Error("liveHeadSha should not have been called");
				},
				...deps,
			}),
		});
		return handle.port;
	}

	function seedStackRun(members: Array<{ prNumber: number; headSha: string }>): string {
		const { runId } = insertChaptersFile(
			db,
			makeFixture(),
			makeRepoContext({ root: repoRoot, originUrl: ORIGIN_URL }),
			members,
		);
		return runId;
	}

	describe("GET /api/stacks/:owner/:repo", () => {
		it("returns the chain graph for the repo", async () => {
			const port = await start();
			const res = await getJson(port, "/api/stacks/acme/app");
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				available: true,
				graph: { complete: true, chains: [{ members: [{ number: 12 }, { number: 13 }] }] },
			});
		});

		it("reports unavailable when gh fails, rather than erroring the list", async () => {
			const port = await start({
				listPullRequests: async () => {
					throw new Error("gh: not authenticated");
				},
			});
			const res = await getJson(port, "/api/stacks/acme/app");
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({ available: false });
		});

		it("marks a capped result incomplete so the UI hides badges", async () => {
			const port = await start({
				listPullRequests: async () => ({ prs: CHAIN, capped: true }),
			});
			const res = await getJson(port, "/api/stacks/acme/app");
			expect(res.body).toMatchObject({ available: true, graph: { complete: false } });
		});
	});

	describe("GET /api/stacks/:owner/:repo/:number/resolve", () => {
		it("reports no-clone when nothing else applies and no clone is known", async () => {
			const port = await start();
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ state: "no-clone", nameWithOwner: "acme/app" });
		});

		it("reports needs-generation once a clone is known", async () => {
			await writeCloneConfig(repoRoot, ORIGIN_URL);
			seedStackRun([]);
			const port = await start();
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.body).toEqual({ state: "needs-generation" });
		});

		it("returns ready for a run whose membership is exactly the chain", async () => {
			const runId = seedStackRun([
				{ prNumber: 12, headSha: A },
				{ prNumber: 13, headSha: B },
			]);
			const port = await start({
				liveHeadSha: async (_repo, prNumber) => (prNumber === 12 ? A : B),
			});
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.body).toEqual({ state: "ready", runId });
		});

		it("reports stale naming a lower member whose head moved", async () => {
			const runId = seedStackRun([
				{ prNumber: 12, headSha: A },
				{ prNumber: 13, headSha: B },
			]);
			// The tip is untouched — only #12 was pushed. Checking the tip alone
			// would call this ready, which is the whole reason members carry heads.
			const port = await start({
				liveHeadSha: async (_repo, prNumber) => (prNumber === 12 ? "c".repeat(40) : B),
			});
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.body).toEqual({ state: "stale", runId, movedPrNumbers: [12] });
		});

		it("stays ready when the live-head check fails", async () => {
			const runId = seedStackRun([
				{ prNumber: 12, headSha: A },
				{ prNumber: 13, headSha: B },
			]);
			const port = await start({
				liveHeadSha: async () => {
					throw new Error("network unreachable");
				},
			});
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.body).toEqual({ state: "ready", runId });
		});

		it("ignores a run whose membership has since changed", async () => {
			await writeCloneConfig(repoRoot, ORIGIN_URL);
			seedStackRun([
				{ prNumber: 11, headSha: A },
				{ prNumber: 13, headSha: B },
			]);
			const port = await start();
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.body).toEqual({ state: "needs-generation" });
		});

		it("404s for a PR that is not the tip of any chain", async () => {
			const port = await start();
			const res = await getJson(port, "/api/stacks/acme/app/12/resolve");
			expect(res.status).toBe(404);
		});

		it("502s when the chain cannot be read", async () => {
			const port = await start({
				listPullRequests: async () => {
					throw new Error("gh: not authenticated");
				},
			});
			const res = await getJson(port, "/api/stacks/acme/app/13/resolve");
			expect(res.status).toBe(502);
		});
	});
});
