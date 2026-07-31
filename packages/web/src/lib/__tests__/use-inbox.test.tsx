// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	INBOX_QUERY_KEY,
	isTerminalJobStatus,
	JOB_STATUS,
	useChapterGeneration,
} from "../use-inbox";
import { RUNS_QUERY_KEY } from "../use-runs";

interface JobStep {
	status: (typeof JOB_STATUS)[keyof typeof JOB_STATUS];
	runId: string | null;
	error: string | null;
}

/** Serves POST /api/generate then one GET per queued job step. */
function installFetch(options: { accept?: { status: number; body: unknown }; steps?: JobStep[] }) {
	const accept = options.accept ?? { status: 202, body: { jobId: "job-1" } };
	const steps = [...(options.steps ?? [])];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			return new Response(JSON.stringify(accept.body), { status: accept.status });
		}
		expect(url).toBe("/api/generate/job-1");
		const step = steps.length > 1 ? steps.shift() : steps[0];
		return new Response(JSON.stringify({ id: "job-1", ...step }), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
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

describe("isTerminalJobStatus", () => {
	it("treats only succeeded and failed as terminal", () => {
		expect(isTerminalJobStatus(JOB_STATUS.QUEUED)).toBe(false);
		expect(isTerminalJobStatus(JOB_STATUS.RUNNING)).toBe(false);
		expect(isTerminalJobStatus(JOB_STATUS.SUCCEEDED)).toBe(true);
		expect(isTerminalJobStatus(JOB_STATUS.FAILED)).toBe(true);
	});
});

describe("useChapterGeneration", () => {
	it("polls to success, exposes the runId, and invalidates the runs and inbox caches", async () => {
		installFetch({ steps: [{ status: JOB_STATUS.SUCCEEDED, runId: "run-9", error: null }] });
		const { client, Wrapper } = makeWrapper();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const { result } = renderHook(() => useChapterGeneration(), { wrapper: Wrapper });
		act(() => {
			result.current.start("https://github.com/o/r/pull/1");
		});

		await waitFor(() => expect(result.current.runId).toBe("run-9"));
		expect(result.current.isRunning).toBe(false);
		expect(result.current.error).toBeNull();

		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toContainEqual(RUNS_QUERY_KEY);
		expect(keys).toContainEqual(INBOX_QUERY_KEY);
	});

	it("surfaces the job's error message when generation fails", async () => {
		installFetch({ steps: [{ status: JOB_STATUS.FAILED, runId: null, error: "agent crashed" }] });
		const { Wrapper } = makeWrapper();

		const { result } = renderHook(() => useChapterGeneration(), { wrapper: Wrapper });
		act(() => {
			result.current.start("https://github.com/o/r/pull/1");
		});

		await waitFor(() => expect(result.current.error).toBe("agent crashed"));
		expect(result.current.runId).toBeNull();
		expect(result.current.isRunning).toBe(false);
	});

	it("surfaces the server's message when the repo has no local clone (422)", async () => {
		installFetch({
			accept: { status: 422, body: { error: "No local clone known for o/r." } },
		});
		const { Wrapper } = makeWrapper();

		const { result } = renderHook(() => useChapterGeneration(), { wrapper: Wrapper });
		act(() => {
			result.current.start("https://github.com/o/r/pull/1");
		});

		await waitFor(() => expect(result.current.error).toBe("No local clone known for o/r."));
		expect(result.current.isRunning).toBe(false);
	});

	it("stays running while the job is queued", async () => {
		installFetch({ steps: [{ status: JOB_STATUS.QUEUED, runId: null, error: null }] });
		const { Wrapper } = makeWrapper();

		const { result } = renderHook(() => useChapterGeneration(), { wrapper: Wrapper });
		act(() => {
			result.current.start("https://github.com/o/r/pull/1");
		});

		await waitFor(() => expect(result.current.status).toBe(JOB_STATUS.QUEUED));
		expect(result.current.isRunning).toBe(true);
		expect(result.current.runId).toBeNull();
	});
});
