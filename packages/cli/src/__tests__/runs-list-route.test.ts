import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/client.js";
import { runRoutes } from "../routes/runs.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { LOOPBACK_HOST, type ServerHandle, startServer } from "../server.js";
import { makeFixture, makeRepoContext } from "./fixtures.js";

let tmpDir: string;
let dbPath: string;
let webDist: string;
const handles: ServerHandle[] = [];

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-cli-routes-"));
	dbPath = path.join(tmpDir, "db.sqlite");
	webDist = path.join(tmpDir, "web-dist");
	await fs.mkdir(webDist);
	await fs.writeFile(path.join(webDist, "index.html"), "<html></html>");
	closeDb();
});

afterEach(async () => {
	while (handles.length > 0) {
		const h = handles.pop();
		if (h) await h.close();
	}
	closeDb();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function startWithRoutes(): Promise<ServerHandle> {
	const db = getDb({ dbPath });
	const handle = await startServer({ webDistPath: webDist, routes: runRoutes(db) });
	handles.push(handle);
	return handle;
}

interface JsonResponse {
	status: number;
	body: unknown;
}

function getJson(port: number, requestPath: string): Promise<JsonResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: LOOPBACK_HOST, port, method: "GET", path: requestPath, agent: false },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({
						status: res.statusCode ?? 0,
						body: text ? JSON.parse(text) : null,
					});
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("GET /api/runs", () => {
	it("returns runs newest-first with chapter counts", async () => {
		const db = getDb({ dbPath });
		insertChaptersFile(
			db,
			makeFixture({ generatedAt: "2026-04-26T12:00:00.000Z" }),
			makeRepoContext(),
		);
		insertChaptersFile(
			db,
			makeFixture({
				generatedAt: "2026-04-27T12:00:00.000Z",
				chapters: [
					{
						id: "chapter-0",
						order: 1,
						title: "First",
						summary: "First summary",
						hunkRefs: [],
						keyChanges: [],
					},
					{
						id: "chapter-1",
						order: 2,
						title: "Second",
						summary: "Second summary",
						hunkRefs: [],
						keyChanges: [],
					},
					{
						id: "chapter-2",
						order: 3,
						title: "Third",
						summary: "Third summary",
						hunkRefs: [],
						keyChanges: [],
					},
				],
			}),
			makeRepoContext(),
			42,
		);

		const { port } = await startWithRoutes();
		const res = await getJson(port, "/api/runs");

		expect(res.status).toBe(200);
		const body = res.body as {
			runs: Array<{
				id: string;
				repoName: string;
				prNumber: number | null;
				scopeKind: string;
				generatedAt: string;
				chapterCount: number;
			}>;
		};
		expect(body.runs).toHaveLength(2);

		const newest = body.runs[0];
		expect(newest?.chapterCount).toBe(3);
		expect(newest?.prNumber).toBe(42);
		expect(typeof newest?.id).toBe("string");
		expect(typeof newest?.repoName).toBe("string");
		expect(typeof newest?.scopeKind).toBe("string");
		expect(typeof newest?.generatedAt).toBe("string");
	});

	it("returns an empty list on a fresh DB", async () => {
		const { port } = await startWithRoutes();
		const res = await getJson(port, "/api/runs");

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ runs: [] });
	});
});
