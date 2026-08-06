import {
	type OwnerReposResponse,
	OwnerReposResponseSchema,
	type OwnersResponse,
	OwnersResponseSchema,
	type RepoPullsResponse,
	RepoPullsResponseSchema,
} from "@stagereview/types/browse";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

/** `gh repo list` / `gh pr list` are slow and their results move slowly — a minute of staleness is fine. */
const GH_STALE_TIME_MS = 60_000;

export const OWNERS_QUERY_KEY = ["owners"] as const;
/** Base key for every `useOwnerRepos` query, regardless of owner — invalidate this prefix to catch all owners at once. */
export const OWNER_REPOS_QUERY_KEY = ["owner-repos"] as const;
/** Base key for every `useRepoPulls` query, regardless of owner/repo — invalidate this prefix to catch all repos at once. */
export const REPO_PULLS_QUERY_KEY = ["repo-pulls"] as const;

/** Distinct owners from the clone index — instant, no `gh` call. */
export function useOwners() {
	return useQuery<OwnersResponse>({
		queryKey: OWNERS_QUERY_KEY,
		queryFn: async () => OwnersResponseSchema.parse(await jsonFetch<unknown>("/api/owners")),
	});
}

export function useOwnerRepos(owner: string) {
	return useQuery<OwnerReposResponse>({
		queryKey: [...OWNER_REPOS_QUERY_KEY, owner.toLowerCase()],
		queryFn: async () =>
			OwnerReposResponseSchema.parse(
				await jsonFetch<unknown>(`/api/owners/${encodeURIComponent(owner)}/repos`),
			),
		staleTime: GH_STALE_TIME_MS,
	});
}

export function useRepoPulls(owner: string, repo: string) {
	return useQuery<RepoPullsResponse>({
		queryKey: [...REPO_PULLS_QUERY_KEY, owner.toLowerCase(), repo.toLowerCase()],
		queryFn: async () =>
			RepoPullsResponseSchema.parse(
				await jsonFetch<unknown>(
					`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
				),
			),
		staleTime: GH_STALE_TIME_MS,
	});
}
