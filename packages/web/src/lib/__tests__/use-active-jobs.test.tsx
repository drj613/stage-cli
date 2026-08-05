// @vitest-environment happy-dom

import type { GenerationJob } from "@stagereview/types/generation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACTIVE_JOBS_QUERY_KEY,
	activeJobsPollInterval,
	findJobForPr,
	POLL_INTERVAL_MS,
	useActiveJobs,
} from "../use-active-jobs";
import { PULL_REQUESTS_QUERY_ROOT } from "../use-pull-requests";

function job(over: Partial<GenerationJob> = {}): GenerationJob {
	return {
		id: "job-1",
		prUrl: "https://github.com/o/r/pull/1",
		status: "running",
		requestedModel: "sonnet",
		runId: null,
		error: null,
		queuePosition: null,
		progress: null,
		...over,
	};
}

/** One response per GET /api/generate, in order; the last entry repeats. */
function installFetch(responses: readonly (GenerationJob[] | "error")[]) {
	const queue = [...responses];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			expect(url).toBe("/api/generate");
			const next = queue.length > 1 ? queue.shift() : queue[0];
			if (next === "error") return new Response("nope", { status: 500 });
			return new Response(JSON.stringify({ jobs: next ?? [] }));
		}),
	);
}

describe("useActiveJobs", () => {
	let client: QueryClient;

	function wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}

	function refetch() {
		return client.refetchQueries({ queryKey: ACTIVE_JOBS_QUERY_KEY });
	}

	beforeEach(() => {
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	});

	// Vitest runs without globals, so RTL's auto-cleanup never registers — an
	// un-unmounted hook would keep polling into the next test's fetch stub.
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("invalidates the pull-request list exactly once when a job goes terminal", async () => {
		installFetch([[job()], [job()], []]);
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const { result } = renderHook(() => useActiveJobs(), { wrapper });
		await waitFor(() => expect(result.current).toHaveLength(1));

		// A tick with the job still running must not invalidate anything.
		await refetch();
		expect(invalidate).not.toHaveBeenCalled();

		// The job departs — one invalidation — and every later empty tick is quiet.
		await refetch();
		await waitFor(() => expect(result.current).toHaveLength(0));
		await refetch();
		await refetch();

		const prCalls = invalidate.mock.calls.filter(
			(call) => call[0]?.queryKey?.[0] === PULL_REQUESTS_QUERY_ROOT,
		);
		expect(prCalls).toHaveLength(1);
	});

	it("never invalidates for a job it only ever saw as absent", async () => {
		installFetch([[]]);
		const invalidate = vi.spyOn(client, "invalidateQueries");

		renderHook(() => useActiveJobs(), { wrapper });
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		await refetch();

		expect(invalidate).not.toHaveBeenCalled();
	});

	it("keeps the last known jobs and invalidates nothing when a poll fails", async () => {
		installFetch([[job()], "error"]);
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const { result } = renderHook(() => useActiveJobs(), { wrapper });
		await waitFor(() => expect(result.current).toHaveLength(1));

		await refetch();

		expect(result.current).toHaveLength(1);
		expect(invalidate).not.toHaveBeenCalled();
	});
});

describe("activeJobsPollInterval", () => {
	it("polls while a job is active and stops once the set is empty", () => {
		expect(activeJobsPollInterval([job()], false)).toBe(POLL_INTERVAL_MS);
		expect(activeJobsPollInterval([], false)).toBe(false);
	});

	it("stops after a failed poll rather than spinning against a dead server", () => {
		expect(activeJobsPollInterval([job()], true)).toBe(false);
	});

	it("polls once the first response has not arrived yet", () => {
		expect(activeJobsPollInterval(undefined, false)).toBe(POLL_INTERVAL_MS);
	});
});

describe("findJobForPr", () => {
	it("matches the PR URL case-insensitively, as the server does", () => {
		const jobs = [job({ prUrl: "https://github.com/Owner/Repo/pull/7" })];

		expect(findJobForPr(jobs, "https://github.com/owner/repo/pull/7")?.id).toBe("job-1");
	});

	it("returns null when no active job belongs to the row", () => {
		expect(findJobForPr([job()], "https://github.com/o/r/pull/2")).toBeNull();
	});
});
