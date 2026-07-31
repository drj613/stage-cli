import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/client.js";
import { JobManager, type JobRequest } from "../generation/job-manager.js";
import { generateRoutes } from "../routes/generate.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { LOOPBACK_HOST, type ServerHandle, startServer } from "../server.js";
import { makeFixture, makeRepoContext } from "./fixtures.js";

interface JsonResponse {
	status: number;
	body: unknown;
}

function request(
	port: number,
	method: string,
	requestPath: string,
	body?: unknown,
): Promise<JsonResponse> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = http.request(
			{
				hostname: LOOPBACK_HOST,
				port,
				method,
				path: requestPath,
				agent: false,
				headers: payload ? { "Content-Type": "application/json" } : {},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
				});
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

const KNOWN_REPO_ROOT = "/clones/acme-widgets";

describe("generate routes", () => {
	let tmpDir = "";
	let handle: ServerHandle | null = null;
	let requested: JobRequest[] = [];
	let jobs: JobManager;
	/** Holds the runner mid-job so a second request lands while one is in flight. */
	let blockRunner: () => void;
	let releaseRunner: () => void;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-generate-"));
		const webDist = path.join(tmpDir, "web-dist");
		await fs.mkdir(webDist);
		await fs.writeFile(path.join(webDist, "index.html"), "<html></html>");
		closeDb();
		const db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
		insertChaptersFile(
			db,
			makeFixture(),
			makeRepoContext({
				root: KNOWN_REPO_ROOT,
				originUrl: "git@github.com:Acme/Widgets.git",
			}),
		);
		requested = [];
		releaseRunner = () => {};
		let blocked: Promise<void> = Promise.resolve();
		blockRunner = () => {
			blocked = new Promise((resolve) => {
				releaseRunner = resolve;
			});
		};
		jobs = new JobManager(async (job) => {
			requested.push(job);
			await blocked;
			return "run-abc";
		});
		handle = await startServer({ webDistPath: webDist, routes: generateRoutes(db, jobs) });
	});

	afterEach(async () => {
		await handle?.close();
		handle = null;
		closeDb();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function port(): number {
		if (!handle) throw new Error("server not started");
		return handle.port;
	}

	it("queues a job against the repo root of a past run", async () => {
		const res = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		expect(res.status).toBe(202);
		await jobs.settled();
		expect(requested).toMatchObject([
			{
				prUrl: "https://github.com/acme/widgets/pull/7",
				repoRoot: KNOWN_REPO_ROOT,
				model: "sonnet",
			},
		]);
		expect(requested).toHaveLength(1);
	});

	it("reports job status once finished", async () => {
		const res = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		await jobs.settled();
		const jobId = expectJobId(res.body);
		const status = await request(port(), "GET", `/api/generate/${jobId}`);
		expect(status.status).toBe(200);
		expect(status.body).toEqual({ id: jobId, status: "succeeded", runId: "run-abc", error: null });
	});

	it("rejects repos with no known local clone", async () => {
		const res = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/other/thing/pull/1",
		});
		expect(res.status).toBe(422);
		expect(requested).toEqual([]);
	});

	it("400s a URL that is not a github.com PR", async () => {
		const res = await request(port(), "POST", "/api/generate", {
			prUrl: "https://gitlab.com/acme/widgets/-/merge_requests/7",
		});
		expect(res.status).toBe(400);
		expect(requested).toEqual([]);
	});

	it("400s a body missing prUrl", async () => {
		const res = await request(port(), "POST", "/api/generate", { model: "opus" });
		expect(res.status).toBe(400);
		expect(requested).toEqual([]);
	});

	it("400s an unknown model", async () => {
		const res = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
			model: "gpt",
		});
		expect(res.status).toBe(400);
		expect(requested).toEqual([]);
	});

	it("reuses the in-flight job for the same PR however the URL is spelled", async () => {
		blockRunner();
		const first = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		const mixedCase = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/Acme/Widgets/pull/7",
		});
		const decorated = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7/files?diff=split#discussion_r1",
		});
		expect(mixedCase.status).toBe(202);
		expect(expectJobId(mixedCase.body)).toBe(expectJobId(first.body));
		expect(expectJobId(decorated.body)).toBe(expectJobId(first.body));
		releaseRunner();
		await jobs.settled();
		expect(requested).toHaveLength(1);
		// The runner always sees the canonical URL, never the decorated one.
		expect(requested[0]?.prUrl).toBe("https://github.com/acme/widgets/pull/7");
	});

	it("starts a fresh job once the previous one for that PR finished", async () => {
		const first = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		await jobs.settled();
		const second = await request(port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		await jobs.settled();
		expect(expectJobId(second.body)).not.toBe(expectJobId(first.body));
		expect(requested).toHaveLength(2);
	});

	it("404s an unknown job", async () => {
		const res = await request(port(), "GET", "/api/generate/does-not-exist");
		expect(res.status).toBe(404);
	});
});

function expectJobId(body: unknown): string {
	if (typeof body === "object" && body !== null && "jobId" in body) {
		const { jobId } = body;
		if (typeof jobId === "string") return jobId;
	}
	throw new Error(`Expected a jobId in ${JSON.stringify(body)}`);
}
