import { describe, expect, it } from "vitest";
import { expectJobId, setupGenerateRoutesTest } from "./generate-route-harness.js";
import { requestJson } from "./runs-route-harness.js";

describe("generate routes — concurrency", () => {
	const env = setupGenerateRoutesTest();

	it("reuses the in-flight job for the same PR however the URL is spelled", async () => {
		env.blockRunner();
		const first = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		const mixedCase = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/Acme/Widgets/pull/7",
		});
		const decorated = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7/files?diff=split#discussion_r1",
		});
		expect(mixedCase.status).toBe(202);
		expect(expectJobId(mixedCase.body)).toBe(expectJobId(first.body));
		expect(expectJobId(decorated.body)).toBe(expectJobId(first.body));
		env.releaseRunner();
		await env.jobs.settled();
		expect(env.requested).toHaveLength(1);
		// The runner always sees the canonical URL, never the decorated one.
		expect(env.requested[0]?.prUrl).toBe("https://github.com/acme/widgets/pull/7");
	});

	it("starts a fresh job once the previous one for that PR finished", async () => {
		const first = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		await env.jobs.settled();
		const second = await requestJson(env.port(), "POST", "/api/generate", {
			prUrl: "https://github.com/acme/widgets/pull/7",
		});
		await env.jobs.settled();
		expect(expectJobId(second.body)).not.toBe(expectJobId(first.body));
		expect(env.requested).toHaveLength(2);
	});
});
