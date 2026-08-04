import type { DashboardPullRequest } from "@stagereview/types/pull-requests";

/**
 * Top-down dedupe: a PR appearing in a higher dashboard section is dropped
 * from this one. A higher section that hasn't resolved (null — still loading
 * or errored) suppresses nothing; the later reflow is the accepted cost of
 * independent per-section failure domains (see design doc).
 */
export function dedupeAgainst(
	rows: DashboardPullRequest[],
	higherSections: (DashboardPullRequest[] | null)[],
): DashboardPullRequest[] {
	const seen = new Set<string>();
	for (const section of higherSections) {
		for (const row of section ?? []) seen.add(row.url.toLowerCase());
	}
	return rows.filter((row) => !seen.has(row.url.toLowerCase()));
}
