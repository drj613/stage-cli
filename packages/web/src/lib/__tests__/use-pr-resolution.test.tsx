// @vitest-environment happy-dom

import type { PrResolution } from "@stagereview/types/pull-requests";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrResolution } from "../use-pr-resolution";

const ADDRESS = { owner: "o", repo: "r", number: "1" };
const RESOLUTION_PATH = "/api/pull-requests/o/r/1";
const RESOLUTION_QUERY_KEY = ["pr-resolution", "o", "r", "1"];
const JOB_ID = "job-1";
const PR_URL = "https://github.com/o/r/pull/1";

/**
 * Serves GET RESOLUTION_PATH from `resolutions` (last entry repeats), POST
 * /api/generate from `accept`, and GET /api/generate/:jobId from `poll`
 * (last entry repeats). Records every POST call in `postCalls`.
 */
function installFetch(opts: {
	resolutions: PrResolution[];
	accept?: { status: number; body: unknown };
	poll?: unknown[];
	postCalls: unknown[];
}) {
	const resolutions = [...opts.resolutions];
	const poll = [...(opts.poll ?? [])];
	const accept = opts.accept ?? { status: 202, body: { jobId: JOB_ID } };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				opts.postCalls.push(JSON.parse(String(init.body)));
				return new Response(JSON.stringify(accept.body), { status: accept.status });
			}
			if (url === RESOLUTION_PATH) {
				const next = resolutions.length > 1 ? resolutions.shift() : resolutions[0];
				if (!next) throw new Error("unexpected resolution fetch");
				return new Response(JSON.stringify(next));
			}
			expect(url).toBe(`/api/generate/${JOB_ID}`);
			const next = poll.length > 1 ? poll.shift() : poll[0];
			if (!next) throw new Error("unexpected poll");
			return new Response(JSON.stringify(next));
		}),
	);
}

function makeWrapper(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}
	return { client, Wrapper };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("usePrResolution — auto-generation gating", () => {
	it("auto-POSTs /api/generate exactly once on needs-generation, then polls the job", async () => {
		const postCalls: unknown[] = [];
		installFetch({
			resolutions: [{ state: "needs-generation" }],
			poll: [
				{
					id: JOB_ID,
					prUrls: [PR_URL],
					status: "running",
					requestedModel: "sonnet",
					runId: null,
					error: null,
					queuePosition: null,
					progress: null,
				},
			],
			postCalls,
		});
		const wrapper = makeWrapper();

		const { result } = renderHook(() => usePrResolution(ADDRESS), { wrapper: wrapper.Wrapper });

		await waitFor(() => expect(postCalls).toHaveLength(1));
		// Deliberately a literal, not PR_URL: this asserts the URL the hook builds
		// from ADDRESS. Pointing it at the fixture's constant would make it a tautology.
		expect(postCalls[0]).toEqual({ prUrls: ["https://github.com/o/r/pull/1"] });
		await waitFor(() => expect(result.current.job?.status).toBeDefined());

		// A second render tick must not fire a second POST.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(postCalls).toHaveLength(1);
	});

	it("does not auto-POST when the resolution is failed", async () => {
		const postCalls: unknown[] = [];
		installFetch({
			resolutions: [{ state: "failed", jobId: JOB_ID, error: "agent crashed" }],
			postCalls,
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.resolution?.state).toBe("failed"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(postCalls).toHaveLength(0);
	});

	it("does not auto-POST when the resolution is stale", async () => {
		const postCalls: unknown[] = [];
		installFetch({
			resolutions: [{ state: "stale", runId: "run-1", movedPrNumbers: [7] }],
			postCalls,
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.resolution?.state).toBe("stale"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(postCalls).toHaveLength(0);
	});

	it("does not auto-POST from a cached needs-generation when the refetch reports failed", async () => {
		const postCalls: unknown[] = [];
		// The mock always answers with `failed` — a real refetch after mount.
		installFetch({
			resolutions: [{ state: "failed", jobId: JOB_ID, error: "agent crashed" }],
			postCalls,
		});
		const { client, Wrapper } = makeWrapper();
		// Seed the cache as if a previous mount already resolved needs-generation.
		client.setQueryData<PrResolution>(RESOLUTION_QUERY_KEY, { state: "needs-generation" });

		const { result } = renderHook(() => usePrResolution(ADDRESS), { wrapper: Wrapper });

		// First render serves the cached needs-generation synchronously.
		expect(result.current.resolution?.state).toBe("needs-generation");

		await waitFor(() => expect(result.current.resolution?.state).toBe("failed"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(postCalls).toHaveLength(0);
	});
});

describe("usePrResolution — generationError", () => {
	it("surfaces the server's own error on a fresh load of a failed resolution", async () => {
		installFetch({
			resolutions: [{ state: "failed", jobId: JOB_ID, error: "agent crashed" }],
			postCalls: [],
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.resolution?.state).toBe("failed"));
		expect(result.current.generationError).toBe("agent crashed");
	});
});
