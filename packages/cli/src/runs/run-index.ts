import { desc, eq } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun, chapterRunPullRequest } from "../db/schema/index.js";
import { parseGitHubRepo, toNameWithOwner } from "../github/repo.js";

export interface PrRun {
	runId: string;
	/** The commit the run was generated against — compared to the live head to detect staleness. */
	headSha: string;
}

/**
 * What past chapter runs tell us about a GitHub repo, indexed by its
 * `owner/name` slug: where it is checked out locally, and the newest run per PR.
 *
 * Both dashboard features need this same walk over `chapter_run` — the PR list to
 * link a PR to its latest review, generation to find a clone to run the agent in.
 * Rows are read newest-generated-first, so the first row seen per key wins.
 */
export class RunIndex {
	private constructor(
		private readonly repoRoots: Map<string, string>,
		private readonly runIds: Map<string, Map<number, PrRun>>,
	) {}

	static empty(): RunIndex {
		return new RunIndex(new Map(), new Map());
	}

	static load(db: StageDb): RunIndex {
		const repoRoots = new Map<string, string>();
		const runIds = new Map<string, Map<number, PrRun>>();

		const rows = db
			.select({
				id: chapterRun.id,
				repoRoot: chapterRun.repoRoot,
				originUrl: chapterRun.originUrl,
				prNumber: chapterRunPullRequest.prNumber,
				headSha: chapterRunPullRequest.headSha,
			})
			.from(chapterRun)
			.leftJoin(chapterRunPullRequest, eq(chapterRunPullRequest.runId, chapterRun.id))
			.orderBy(desc(chapterRun.generatedAt))
			.all();

		// One row per member, so a stack run appears once per PR. Counting members
		// per run is what lets the lookup skip stack runs: clicking a single PR must
		// open that PR alone, never the chain it happens to sit in.
		const memberCounts = new Map<string, number>();
		for (const row of rows) {
			if (row.prNumber === null) continue;
			memberCounts.set(row.id, (memberCounts.get(row.id) ?? 0) + 1);
		}

		for (const row of rows) {
			const repo = parseGitHubRepo(row.originUrl);
			if (!repo) continue;
			// One normalized key for both maps, so a mixed-case remote still matches.
			const key = toNameWithOwner(repo).toLowerCase();
			if (!repoRoots.has(key)) repoRoots.set(key, row.repoRoot);
			if (row.prNumber === null || row.headSha === null) continue;
			if (memberCounts.get(row.id) !== 1) continue;
			let byPrNumber = runIds.get(key);
			if (!byPrNumber) {
				byPrNumber = new Map();
				runIds.set(key, byPrNumber);
			}
			if (!byPrNumber.has(row.prNumber)) {
				byPrNumber.set(row.prNumber, { runId: row.id, headSha: row.headSha });
			}
		}

		return new RunIndex(repoRoots, runIds);
	}

	/**
	 * Newest run that reviews this PR *and nothing else*, with the head it was
	 * generated at. Stack runs are excluded on purpose: clicking one PR must open
	 * that PR, not the chain around it.
	 */
	latestSinglePrRunFor(nameWithOwner: string, prNumber: number): PrRun | null {
		return this.runIds.get(nameWithOwner.toLowerCase())?.get(prNumber) ?? null;
	}

	/** Newest single-PR run for a PR, or null if Stage has never generated one. */
	singlePrRunIdFor(nameWithOwner: string, prNumber: number): string | null {
		return this.latestSinglePrRunFor(nameWithOwner, prNumber)?.runId ?? null;
	}

	/** A local clone of the repo Stage has generated from before, or null. */
	repoRootFor(nameWithOwner: string): string | null {
		return this.repoRoots.get(nameWithOwner.toLowerCase()) ?? null;
	}
}
