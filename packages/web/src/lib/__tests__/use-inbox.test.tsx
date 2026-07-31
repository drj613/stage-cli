// @vitest-environment happy-dom

import {
	type GenerationJob,
	isTerminalJobStatus,
	JOB_STATUS,
	type JobStatus,
} from "@stagereview/types/generation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_QUERY_KEY, useChapterGeneration } from "../use-inbox";
import { RUNS_QUERY_KEY } from "../use-runs";

const PR_URL = "https://github.com/o/r/pull/1";
const JOB_ID = "job-1";

interface HttpResponse {
	status: number;
	body: unknown;
}

const ACCEPTED: HttpResponse = { status: 202, body: { jobId: JOB_ID } };

/** A 200 GET /api/generate/:jobId response. */
function polled(status: JobStatus, over: Partial<GenerationJob> = {}): HttpResponse {
	return {
		status: 200,
		body: { id: JOB_ID, status, runId: null, error: null, ...over },
	};
}

/**
 * Serves POST /api/generate from `accept`, then walks `poll` one response per
 * GET — the last entry repeats for every later poll.
 */
function installFetch(plan: { accept?: HttpResponse; poll?: HttpResponse[] }) {
	const accept = plan.accept ?? ACCEPTED;
	const poll = [...(plan.poll ?? [])];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") {
				return new Response(JSON.stringify(accept.body), { status: accept.status });
			}
			expect(url).toBe(`/api/generate/${JOB_ID}`);
			const next = poll.length > 1 ? poll.shift() : poll[0];
			if (!next) throw new Error("unexpected poll");
			return new Response(JSON.stringify(next.body), { status: next.status });
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

function startGeneration(wrapper: ReturnType<typeof makeWrapper>) {
	const { result } = renderHook(() => useChapterGeneration(), { wrapper: wrapper.Wrapper });
	act(() => {
		result.current.start(PR_URL);
	});
	return result;
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
		installFetch({ poll: [polled(JOB_STATUS.SUCCEEDED, { runId: "run-9" })] });
		const wrapper = makeWrapper();
		const invalidate = vi.spyOn(wrapper.client, "invalidateQueries");

		const result = startGeneration(wrapper);

		await waitFor(() => expect(result.current.runId).toBe("run-9"));
		expect(result.current.isRunning).toBe(false);
		expect(result.current.error).toBeNull();

		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toContainEqual(RUNS_QUERY_KEY);
		expect(keys).toContainEqual(INBOX_QUERY_KEY);
	});

	it("surfaces the job's error message when generation fails", async () => {
		installFetch({ poll: [polled(JOB_STATUS.FAILED, { error: "agent crashed" })] });

		const result = startGeneration(makeWrapper());

		await waitFor(() => expect(result.current.error).toBe("agent crashed"));
		expect(result.current.runId).toBeNull();
		expect(result.current.isRunning).toBe(false);
	});

	it("surfaces the server's message when the repo has no local clone (422)", async () => {
		installFetch({ accept: { status: 422, body: { error: "No local clone known for o/r." } } });

		const result = startGeneration(makeWrapper());

		await waitFor(() => expect(result.current.error).toBe("No local clone known for o/r."));
		expect(result.current.isRunning).toBe(false);
	});

	it("stops polling and reports the failure when the job disappears", async () => {
		installFetch({ poll: [{ status: 404, body: { error: "Job not found" } }] });

		const result = startGeneration(makeWrapper());

		await waitFor(() => expect(result.current.error).not.toBeNull());
		expect(result.current.isRunning).toBe(false);
		expect(result.current.status).toBeNull();
	});

	it("stays running while the job is queued", async () => {
		installFetch({ poll: [polled(JOB_STATUS.QUEUED)] });

		const result = startGeneration(makeWrapper());

		await waitFor(() => expect(result.current.status).toBe(JOB_STATUS.QUEUED));
		expect(result.current.isRunning).toBe(true);
		expect(result.current.runId).toBeNull();
	});
});
