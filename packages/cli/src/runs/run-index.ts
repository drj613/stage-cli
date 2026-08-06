import { desc } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
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

		const runs = db
			.select({
				id: chapterRun.id,
				repoRoot: chapterRun.repoRoot,
				originUrl: chapterRun.originUrl,
				prNumber: chapterRun.prNumber,
				headSha: chapterRun.headSha,
			})
			.from(chapterRun)
			.orderBy(desc(chapterRun.generatedAt))
			.all();

		for (const run of runs) {
			const repo = parseGitHubRepo(run.originUrl);
			if (!repo) continue;
			const nameWithOwner = toNameWithOwner(repo);
			if (!repoRoots.has(nameWithOwner)) repoRoots.set(nameWithOwner, run.repoRoot);
			if (run.prNumber === null) continue;
			let byPrNumber = runIds.get(nameWithOwner);
			if (!byPrNumber) {
				byPrNumber = new Map();
				runIds.set(nameWithOwner, byPrNumber);
			}
			if (!byPrNumber.has(run.prNumber)) {
				byPrNumber.set(run.prNumber, { runId: run.id, headSha: run.headSha });
			}
		}

		return new RunIndex(repoRoots, runIds);
	}

	/** Newest run for a PR with the head it was generated at, or null. */
	latestRunFor(nameWithOwner: string, prNumber: number): PrRun | null {
		return this.runIds.get(nameWithOwner.toLowerCase())?.get(prNumber) ?? null;
	}

	/** Newest run for a PR, or null if Stage has never generated chapters for it. */
	runIdFor(nameWithOwner: string, prNumber: number): string | null {
		return this.latestRunFor(nameWithOwner, prNumber)?.runId ?? null;
	}

	/** A local clone of the repo Stage has generated from before, or null. */
	repoRootFor(nameWithOwner: string): string | null {
		return this.repoRoots.get(nameWithOwner.toLowerCase()) ?? null;
	}
}
