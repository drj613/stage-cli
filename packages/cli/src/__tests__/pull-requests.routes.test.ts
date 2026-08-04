import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneRegistry } from "../clones/clone-registry.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { JobManager } from "../generation/job-manager.js";
import { pullRequestListRoutes } from "../routes/pull-requests.js";
import { SCOPE_KIND } from "../schema.js";
import { type ServerHandle, startServer } from "../server.js";
import { writeCloneConfig } from "./fixtures.js";
import { getJson as request } from "./runs-route-harness.js";

const ORIGIN_URL = "git@github.com:acme/widgets.git";
const NAME_WITH_OWNER = "acme/widgets";
const PR_NUMBER = 7;
const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PR_URL = `https://github.com/${NAME_WITH_OWNER}/pull/${PR_NUMBER}`;

describe("pull-requests routes", () => {
	let tmpDir = "";
	let repoRoot = "";
	let db: StageDb;
	let handle: ServerHandle | null = null;
	let jobs: JobManager;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-pull-requests-"));
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

	function seedRun(headSha: string, prNumber: number | null = PR_NUMBER): void {
		db.insert(chapterRun)
			.values({
				repoRoot,
				originUrl: ORIGIN_URL,
				prNumber,
				scopeKind: SCOPE_KIND.COMMITTED,
				workingTreeRef: null,
				baseSha: HEAD_SHA,
				headSha,
				mergeBaseSha: HEAD_SHA,
				generatedAt: new Date(),
			})
			.run();
	}

	/** Registers the repo as a known clone (via RunIndex) without generating a run for our PR. */
	async function makeClone(): Promise<void> {
		await writeCloneConfig(repoRoot, ORIGIN_URL);
		seedRun(HEAD_SHA, null);
	}

	async function start(liveHeadSha: (nameWithOwner: string, prNumber: number) => Promise<string>) {
		const registry = CloneRegistry.create(db);
		handle = await startServer({
			routes: pullRequestListRoutes(db, jobs, registry, { liveHeadSha }),
		});
		return handle.port;
	}

	const neverCalled = async (): Promise<string> => {
		throw new Error("liveHeadSha should not have been called");
	};

	it("returns ready when a run exists and the head matches", async () => {
		seedRun(HEAD_SHA);
		const port = await start(async () => HEAD_SHA);
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ state: "ready" });
	});

	it("returns stale with runId and headSha when the head moved", async () => {
		seedRun(HEAD_SHA);
		const port = await start(async () => OTHER_SHA);
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ state: "stale", headSha: HEAD_SHA });
	});

	it("returns ready when the live-head check fails (offline)", async () => {
		seedRun(HEAD_SHA);
		const port = await start(async () => {
			throw new Error("network unreachable");
		});
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ state: "ready" });
	});

	it("returns generating with the active jobId", async () => {
		let releaseRunner: () => void = () => {};
		jobs = new JobManager(
			() =>
				new Promise((resolve) => {
					releaseRunner = () => resolve("run-abc");
				}),
		);
		const jobId = jobs.enqueue({ prUrl: PR_URL, repoRoot, model: "sonnet" });
		const port = await start(neverCalled);
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ state: "generating", jobId });
		releaseRunner();
		await jobs.settled();
	});

	it("returns failed with the job error after a failed run", async () => {
		jobs = new JobManager(async () => {
			throw new Error("agent exploded");
		});
		jobs.enqueue({ prUrl: PR_URL, repoRoot, model: "sonnet" });
		await jobs.settled();
		const port = await start(neverCalled);
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ state: "failed", error: "agent exploded" });
	});

	it("returns needs-generation when a clone is known and nothing else applies", async () => {
		await makeClone();
		const port = await start(neverCalled);
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ state: "needs-generation" });
	});

	it("returns no-clone with nameWithOwner otherwise", async () => {
		const port = await start(neverCalled);
		const res = await request(port, `/api/pull-requests/acme/widgets/${PR_NUMBER}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ state: "no-clone", nameWithOwner: NAME_WITH_OWNER });
	});

	it("rejects an unknown filter on the list endpoint with 400", async () => {
		const port = await start(neverCalled);
		const res = await request(port, "/api/pull-requests?filter=bogus");
		expect(res.status).toBe(400);
	});
});
