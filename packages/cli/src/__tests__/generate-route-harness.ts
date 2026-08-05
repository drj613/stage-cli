import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	GENERATION_PHASE,
	type GenerationModel,
	type JobProgress,
} from "@stagereview/types/generation";
import { afterEach, beforeEach } from "vitest";
import { CloneRegistry } from "../clones/clone-registry.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";
import { JobManager, type JobRequest } from "../generation/job-manager.js";
import { generateRoutes } from "../routes/generate.js";
import { insertChaptersFile } from "../runs/import-chapters.js";
import { type ServerHandle, startServer } from "../server.js";
import { makeFixture, makeRepoContext, writeCloneConfig } from "./fixtures.js";

const KNOWN_ORIGIN_URL = "git@github.com:Acme/Widgets.git";

export interface GenerateRoutesEnv {
	readonly tmpDir: string;
	/** A clone with one past run already generated against it, `acme/widgets`. */
	readonly knownRepoRoot: string;
	readonly db: StageDb;
	readonly registry: CloneRegistry;
	readonly jobs: JobManager;
	/** Every job the injected runner has been asked to run, in request order. */
	readonly requested: JobRequest[];
	port(): number;
	/** Holds the runner mid-job so a second request lands while one is in flight. */
	blockRunner(): void;
	releaseRunner(): void;
	/** Pushes a progress snapshot from inside the currently running job. */
	pushProgress(progress: JobProgress): void;
	/**
	 * Makes every job from here to the end of the test fail, after reporting progress
	 * up to the write phase. `beforeEach` is what clears it, not the failing run.
	 */
	failRunner(message: string): void;
	/** Restarts the server with a different default model — for model-fallback tests only. */
	restartWithDefaultModel(model: GenerationModel): Promise<void>;
}

/**
 * Shared beforeEach/afterEach for every `/api/generate` route test file: a
 * temp SQLite db, a known clone with one past run, and a `JobManager` whose
 * runner can be paused mid-job to exercise concurrency behavior.
 */
export function setupGenerateRoutesTest(): GenerateRoutesEnv {
	let tmpDir = "";
	let knownRepoRoot = "";
	let handle: ServerHandle | null = null;
	let requested: JobRequest[] = [];
	let jobs: JobManager;
	let db: StageDb;
	let registry: CloneRegistry;
	let blocked: Promise<void> = Promise.resolve();
	let releaseRunner: () => void = () => {};
	let pushProgress: (progress: JobProgress) => void = () => {};
	let failure: string | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-generate-"));
		const webDist = path.join(tmpDir, "web-dist");
		await fs.mkdir(webDist);
		await fs.writeFile(path.join(webDist, "index.html"), "<html></html>");
		closeDb();
		db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
		knownRepoRoot = path.join(tmpDir, "clones", "acme-widgets");
		await writeCloneConfig(knownRepoRoot, KNOWN_ORIGIN_URL);
		insertChaptersFile(
			db,
			makeFixture(),
			makeRepoContext({ root: knownRepoRoot, originUrl: KNOWN_ORIGIN_URL }),
		);
		registry = CloneRegistry.create(db);
		requested = [];
		blocked = Promise.resolve();
		releaseRunner = () => {};
		pushProgress = () => {};
		failure = null;
		jobs = new JobManager(async (job, onProgress) => {
			requested.push(job);
			pushProgress = onProgress;
			if (failure !== null) {
				onProgress({
					startedAt: 1,
					endedAt: null,
					resolvedModel: null,
					turns: 1,
					phase: GENERATION_PHASE.WRITE,
					activity: [],
				});
				throw new Error(failure);
			}
			await blocked;
			return "run-abc";
		});
		handle = await startServer({ webDistPath: webDist, routes: generateRoutes(jobs, registry) });
	});

	afterEach(async () => {
		await handle?.close();
		handle = null;
		closeDb();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	return {
		get tmpDir() {
			return tmpDir;
		},
		get knownRepoRoot() {
			return knownRepoRoot;
		},
		get db() {
			return db;
		},
		get registry() {
			return registry;
		},
		get jobs() {
			return jobs;
		},
		get requested() {
			return requested;
		},
		port() {
			if (!handle) throw new Error("server not started");
			return handle.port;
		},
		blockRunner() {
			blocked = new Promise((resolve) => {
				releaseRunner = resolve;
			});
		},
		releaseRunner() {
			releaseRunner();
		},
		pushProgress(progress: JobProgress) {
			pushProgress(progress);
		},
		failRunner(message: string) {
			failure = message;
		},
		async restartWithDefaultModel(model) {
			await handle?.close();
			handle = await startServer({ routes: generateRoutes(jobs, registry, model) });
		},
	};
}

export function expectJobId(body: unknown): string {
	if (typeof body === "object" && body !== null && "jobId" in body) {
		const { jobId } = body;
		if (typeof jobId === "string") return jobId;
	}
	throw new Error(`Expected a jobId in ${JSON.stringify(body)}`);
}
