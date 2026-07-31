import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { closeDb, getDb } from "../db/client.js";
import { runRoutes } from "../routes/runs.js";
import { LOOPBACK_HOST, type ServerHandle, startServer } from "../server.js";

export interface JsonResponse {
	status: number;
	body: unknown;
}

// Fires a raw GET request at a running runs-routes server. Shared across every
// runs test file — the request/response plumbing never varies per test.
export function getJson(port: number, requestPath: string): Promise<JsonResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: LOOPBACK_HOST, port, method: "GET", path: requestPath, agent: false },
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
		req.end();
	});
}

export interface RunRoutesTestEnv {
	/** Path of the current test's temp SQLite file. Live-updates every `beforeEach`. */
	readonly dbPath: string;
	startWithRoutes(): Promise<ServerHandle>;
}

// Registers the beforeEach/afterEach lifecycle every runs-routes test file needs
// (temp SQLite db, temp web-dist, server cleanup) and returns helpers bound to that
// per-test state. Vitest gives each test file its own module graph, so two test
// files calling this each get an independent temp dir and server-handle list —
// nothing leaks between runs.routes.test.ts and runs-list-route.test.ts.
export function setupRunRoutesTest(tmpPrefix: string): RunRoutesTestEnv {
	let tmpDir = "";
	let dbPath = "";
	let webDist = "";
	const handles: ServerHandle[] = [];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
		dbPath = path.join(tmpDir, "db.sqlite");
		webDist = path.join(tmpDir, "web-dist");
		await fs.mkdir(webDist);
		await fs.writeFile(path.join(webDist, "index.html"), "<html></html>");
		closeDb();
	});

	afterEach(async () => {
		for (const h of handles.splice(0)) await h.close();
		closeDb();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function startWithRoutes(): Promise<ServerHandle> {
		const db = getDb({ dbPath });
		const handle = await startServer({ webDistPath: webDist, routes: runRoutes(db) });
		handles.push(handle);
		return handle;
	}

	return {
		get dbPath() {
			return dbPath;
		},
		startWithRoutes,
	};
}
