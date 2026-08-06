import { describe, expect, it } from "vitest";
import { setupGenerateRoutesTest } from "./generate-route-harness.js";
import { requestJson } from "./runs-route-harness.js";

describe("generate routes — default model", () => {
	const env = setupGenerateRoutesTest();

	it("falls back to the server's default model when the body omits one", async () => {
		await env.restartWithDefaultModel("opus");
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		expect(res.status).toBe(202);
		await env.jobs.settled();
		expect(env.requested).toMatchObject([{ requestedModel: "opus" }]);
	});

	it("lets a request body override the server's default model", async () => {
		await env.restartWithDefaultModel("opus");
		const res = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
			model: "haiku",
		});
		expect(res.status).toBe(202);
		await env.jobs.settled();
		expect(env.requested).toMatchObject([{ requestedModel: "haiku" }]);
	});
});
