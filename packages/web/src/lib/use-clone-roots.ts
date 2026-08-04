import {
	type CloneRootsResponse,
	CloneRootsResponseSchema,
	type RescanResponse,
	RescanResponseSchema,
} from "@stagereview/types/clone-roots";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { OWNER_REPOS_QUERY_KEY, OWNERS_QUERY_KEY, REPO_PULLS_QUERY_KEY } from "./use-browse";
import { PULL_REQUESTS_QUERY_ROOT } from "./use-pull-requests";
import { jsonFetch } from "./use-view-state";

export const CLONE_ROOTS_QUERY_KEY = ["clone-roots"] as const;
const ErrorBodySchema = z.object({ error: z.string() });

export function useCloneRoots() {
	return useQuery<CloneRootsResponse>({
		queryKey: CLONE_ROOTS_QUERY_KEY,
		queryFn: async () =>
			CloneRootsResponseSchema.parse(await jsonFetch<unknown>("/api/clone-roots")),
	});
}

async function mutateRoots(method: "POST" | "DELETE", path: string): Promise<CloneRootsResponse> {
	const res = await fetch("/api/clone-roots", {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
	const raw: unknown = await res.json();
	if (!res.ok) {
		const parsed = ErrorBodySchema.safeParse(raw);
		throw new Error(
			parsed.success ? parsed.data.error : `${method} /api/clone-roots failed: ${res.status}`,
		);
	}
	return CloneRootsResponseSchema.parse(raw);
}

/**
 * Root writes invalidate everything derived from the scan — including
 * `owner-repos` and `repo-pulls`, which carry the same `cloned` flag a root
 * add/remove is meant to change. Missing either would leave a stale
 * "Not cloned" badge on `/browse/$owner` or `/browse/$owner/$repo` for up to
 * their staleTime.
 */
function useRootsMutation(method: "POST" | "DELETE") {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (path: string) => mutateRoots(method, path),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: CLONE_ROOTS_QUERY_KEY });
			void queryClient.invalidateQueries({ queryKey: OWNERS_QUERY_KEY });
			void queryClient.invalidateQueries({ queryKey: OWNER_REPOS_QUERY_KEY });
			void queryClient.invalidateQueries({ queryKey: REPO_PULLS_QUERY_KEY });
			void queryClient.invalidateQueries({ queryKey: [PULL_REQUESTS_QUERY_ROOT] });
		},
	});
}

export function useAddCloneRoot() {
	return useRootsMutation("POST");
}

export function useRemoveCloneRoot() {
	return useRootsMutation("DELETE");
}

export function useRescan() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (): Promise<RescanResponse> => {
			const res = await fetch("/api/clone-roots/rescan", { method: "POST" });
			return RescanResponseSchema.parse(await res.json());
		},
		// A rescan can change owners, repo `cloned` flags, and PR resolution
		// state everywhere at once — narrower invalidation would risk missing a
		// derived query, so the whole cache is invalidated on purpose.
		onSuccess: () => {
			void queryClient.invalidateQueries();
		},
	});
}
