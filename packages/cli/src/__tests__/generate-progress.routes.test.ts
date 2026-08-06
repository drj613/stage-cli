import {
	ACTIVITY_STATE,
	ActiveGenerationJobsSchema,
	GENERATION_MODEL,
	GENERATION_PHASE,
	GenerationJobSchema,
	JOB_STATUS,
} from "@stagereview/types/generation";
import { describe, expect, it } from "vitest";
import { expectJobId, setupGenerateRoutesTest } from "./generate-route-harness.js";
import { requestJson } from "./runs-route-harness.js";

const PR_URL = "https://github.com/Acme/Widgets/pull/7";

describe("GET /api/generate/:jobId progress", () => {
	const env = setupGenerateRoutesTest();

	it("reports the requested model, prUrl, and live progress", async () => {
		env.blockRunner();
		const start = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: PR_URL,
			model: GENERATION_MODEL.OPUS,
		});
		const jobId = expectJobId(start.body);
		env.pushProgress({
			startedAt: 1,
			endedAt: null,
			resolvedModel: "claude-opus-5",
			turns: 4,
			phase: GENERATION_PHASE.ANALYZE,
			activity: [{ tool: "Read", target: "src/a.ts", state: ACTIVITY_STATE.DONE }],
		});

		const res = await requestJson(env.port(), "GET", `/api/generate/${jobId}`);
		expect(res.status).toBe(200);
		const job = GenerationJobSchema.parse(res.body);
		expect(job).toMatchObject({
			prUrl: PR_URL,
			requestedModel: GENERATION_MODEL.OPUS,
			status: JOB_STATUS.RUNNING,
			progress: {
				phase: GENERATION_PHASE.ANALYZE,
				turns: 4,
				resolvedModel: "claude-opus-5",
				activity: [{ tool: "Read", target: "src/a.ts", state: ACTIVITY_STATE.DONE }],
			},
		});

		env.releaseRunner();
		await env.jobs.settled();
	});

	it("keeps the snapshot after the job fails", async () => {
		env.failRunner("boom");
		const start = await requestJson(env.port(), "POST", "/api/generate", { prUrl: PR_URL });
		const jobId = expectJobId(start.body);
		await env.jobs.settled();

		const res = await requestJson(env.port(), "GET", `/api/generate/${jobId}`);
		const job = GenerationJobSchema.parse(res.body);
		expect(job.status).toBe(JOB_STATUS.FAILED);
		expect(job.error).toBe("boom");
		expect(job.progress?.phase).toBe(GENERATION_PHASE.WRITE);
	});

	it("serves an end time once the job is over, so the SPA can stop its clock", async () => {
		env.blockRunner();
		const start = await requestJson(env.port(), "POST", "/api/generate", { prUrl: PR_URL });
		const jobId = expectJobId(start.body);
		env.pushProgress({
			startedAt: 1,
			endedAt: null,
			resolvedModel: null,
			turns: 2,
			phase: GENERATION_PHASE.IMPORT,
			activity: [],
		});

		const during = GenerationJobSchema.parse(
			(await requestJson(env.port(), "GET", `/api/generate/${jobId}`)).body,
		);
		expect(during.progress?.endedAt).toBeNull();

		env.releaseRunner();
		await env.jobs.settled();

		const after = GenerationJobSchema.parse(
			(await requestJson(env.port(), "GET", `/api/generate/${jobId}`)).body,
		);
		expect(after.status).toBe(JOB_STATUS.SUCCEEDED);
		expect(after.progress?.endedAt).toBeGreaterThan(0);
	});
});

describe("GET /api/generate", () => {
	const env = setupGenerateRoutesTest();

	it("lists non-terminal jobs and drops them once they finish", async () => {
		env.blockRunner();
		const start = await requestJson(env.port(), "POST", "/api/generate", { prUrl: PR_URL });
		const jobId = expectJobId(start.body);

		const during = ActiveGenerationJobsSchema.parse(
			(await requestJson(env.port(), "GET", "/api/generate")).body,
		);
		expect(during.jobs.map((job) => job.id)).toEqual([jobId]);

		env.releaseRunner();
		await env.jobs.settled();

		const after = ActiveGenerationJobsSchema.parse(
			(await requestJson(env.port(), "GET", "/api/generate")).body,
		);
		expect(after.jobs).toEqual([]);
	});

	it("returns an empty list with a 200 when nothing is running", async () => {
		const res = await requestJson(env.port(), "GET", "/api/generate");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ jobs: [] });
	});

	it("never ships the job's repoRoot", async () => {
		env.blockRunner();
		await requestJson(env.port(), "POST", "/api/generate", { prUrl: PR_URL });
		const res = await requestJson(env.port(), "GET", "/api/generate");
		expect(JSON.stringify(res.body)).not.toContain(env.knownRepoRoot);

		env.releaseRunner();
		await env.jobs.settled();
	});
});
