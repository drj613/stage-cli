// @vitest-environment happy-dom

import type { GenerationJob } from "@stagereview/types/generation";
import type { PrResolution } from "@stagereview/types/pull-requests";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO_PULLS_QUERY_KEY } from "../use-browse";
import { usePrResolution } from "../use-pr-resolution";
import { PULL_REQUESTS_QUERY_ROOT } from "../use-pull-requests";
import { RUNS_QUERY_KEY } from "../use-runs";

const ADDRESS = { owner: "o", repo: "r", number: "1" };
const RESOLUTION_PATH = "/api/pull-requests/o/r/1";
const JOB_ID = "job-1";

function job(over: Partial<GenerationJob> = {}): GenerationJob {
	return {
		id: JOB_ID,
		prUrls: ["https://github.com/o/r/pull/1"],
		status: "running",
		requestedModel: "sonnet",
		runId: null,
		error: null,
		queuePosition: null,
		progress: null,
		...over,
	};
}

/**
 * Serves GET RESOLUTION_PATH from `resolution`, POST /api/generate from
 * `accept`, and GET /api/generate/:jobId by walking `poll` one response per
 * call (last entry repeats).
 */
function installFetch(opts: {
	resolution: PrResolution;
	accept?: { status: number; body: unknown };
	/** Unknown rather than GenerationJob so a test can serve a payload the schema rejects. */
	poll?: unknown[];
}) {
	const accept = opts.accept ?? { status: 202, body: { jobId: JOB_ID } };
	const poll = [...(opts.poll ?? [])];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				return new Response(JSON.stringify(accept.body), { status: accept.status });
			}
			if (url === RESOLUTION_PATH) return new Response(JSON.stringify(opts.resolution));
			expect(url).toBe(`/api/generate/${JOB_ID}`);
			const next = poll.length > 1 ? poll.shift() : poll[0];
			if (!next) throw new Error("unexpected poll");
			return new Response(JSON.stringify(next));
		}),
	);
}

function makeWrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}
	return { client, Wrapper };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("usePrResolution — job adoption and lifecycle", () => {
	it("adopts the jobId from a generating resolution and polls it", async () => {
		installFetch({
			resolution: { state: "generating", jobId: JOB_ID },
			poll: [job({ status: "succeeded", runId: "run-9" })],
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.runId).toBe("run-9"));
	});

	it("exposes queuePosition from the polled job", async () => {
		installFetch({
			resolution: { state: "generating", jobId: JOB_ID },
			poll: [job({ status: "queued", queuePosition: 2 })],
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.job?.queuePosition).toBe(2));
	});

	it("retry() POSTs after a failure and transitions to polling", async () => {
		installFetch({
			resolution: { state: "failed", jobId: "old-job", error: "agent crashed" },
			poll: [job({ status: "running" })],
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.resolution?.state).toBe("failed"));
		expect(result.current.job).toBeNull();

		result.current.generate();

		await waitFor(() => expect(result.current.job?.status).toBe("running"));
	});

	it("resumes the poll on Retry after it died on a payload the schema rejects", async () => {
		// The poll doesn't retry, and Retry re-adopts the same jobId, so without a
		// reset the query stays parked in error on an unchanged key and the button
		// does nothing at all.
		installFetch({
			resolution: { state: "generating", jobId: JOB_ID },
			poll: [{ id: JOB_ID }, job({ status: "running" })],
		});
		const { result } = renderHook(() => usePrResolution(ADDRESS), {
			wrapper: makeWrapper().Wrapper,
		});

		await waitFor(() => expect(result.current.pollError).not.toBeNull());

		result.current.generate();

		await waitFor(() => expect(result.current.job?.status).toBe("running"));
		expect(result.current.pollError).toBeNull();
	});

	it("invalidates runs and every pull-request cache when the job succeeds", async () => {
		installFetch({
			resolution: { state: "generating", jobId: JOB_ID },
			poll: [job({ status: "succeeded", runId: "run-9" })],
		});
		const { client, Wrapper } = makeWrapper();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const { result } = renderHook(() => usePrResolution(ADDRESS), { wrapper: Wrapper });

		await waitFor(() => expect(result.current.runId).toBe("run-9"));

		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toContainEqual(RUNS_QUERY_KEY);
		expect(keys).toContainEqual([PULL_REQUESTS_QUERY_ROOT]);
		expect(keys).toContainEqual(REPO_PULLS_QUERY_KEY);
	});
});
