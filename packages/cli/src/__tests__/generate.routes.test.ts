import path from "node:path";
import { describe, expect, it } from "vitest";
import { addCloneRoot } from "../clones/clone-root-store.js";
import { writeCloneConfig } from "./fixtures.js";
import { expectJobId, setupGenerateRoutesTest } from "./generate-route-harness.js";
import { requestJson } from "./runs-route-harness.js";

describe("generate routes", () => {
	const env = setupGenerateRoutesTest();

	it("queues a job against the repo root of a past run", async () => {
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		expect(res.status).toBe(202);
		await env.jobs.settled();
		expect(env.requested).toMatchObject([
			{
				prUrl: "https://github.com/acme/widgets/pull/7",
				repoRoot: env.knownRepoRoot,
				requestedModel: "sonnet",
			},
		]);
		expect(env.requested).toHaveLength(1);
	});

	it("reports job status once finished", async () => {
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		await env.jobs.settled();
		const jobId = expectJobId(res.body);
		const status = await requestJson(env.port(), "GET", `/api/generate/${jobId}`);
		expect(status.status).toBe(200);
		// Exhaustive on purpose: repoRoot is an absolute path on the user's machine
		// and must never appear in a response.
		expect(status.body).toEqual({
			id: jobId,
			prUrl: "https://github.com/acme/widgets/pull/7",
			status: "succeeded",
			requestedModel: "sonnet",
			runId: "run-abc",
			error: null,
			queuePosition: null,
			progress: null,
		});
	});

	it("accepts a PR resolved through the clone index alone, with no prior run", async () => {
		const rootsDir = path.join(env.tmpDir, "roots");
		const gadgetsRoot = path.join(rootsDir, "gadgets");
		await writeCloneConfig(gadgetsRoot, "git@github.com:acme/gadgets.git");
		addCloneRoot(env.db, rootsDir);
		env.registry.rescan();
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/gadgets/pull/3",
		});
		expect(res.status).toBe(202);
		await env.jobs.settled();
		expect(env.requested).toMatchObject([{ repoRoot: gadgetsRoot }]);
	});

	it("rejects repos with no known local clone", async () => {
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/other/thing/pull/1",
		});
		expect(res.status).toBe(422);
		expect(env.requested).toEqual([]);
	});

	it("400s a URL that is not a github.com PR", async () => {
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://gitlab.com/acme/widgets/-/merge_requests/7",
		});
		expect(res.status).toBe(400);
		expect(env.requested).toEqual([]);
	});

	it("400s a body missing prUrl", async () => {
		const res = await requestJson(env.port(), "POST", "/api/generate", { model: "opus" });
		expect(res.status).toBe(400);
		expect(env.requested).toEqual([]);
	});

	it("400s an unknown model", async () => {
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
			model: "gpt",
		});
		expect(res.status).toBe(400);
		expect(env.requested).toEqual([]);
	});

	it("404s an unknown job", async () => {
		const res = await requestJson(env.port(), "GET", "/api/generate/does-not-exist");
		expect(res.status).toBe(404);
	});
});
