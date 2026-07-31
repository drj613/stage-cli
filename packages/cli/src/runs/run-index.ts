import { desc } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { parseGitHubRepo, toNameWithOwner } from "../github/repo.js";

/**
 * What past chapter runs tell us about a GitHub repo, indexed by its
 * `owner/name` slug: where it is checked out locally, and the newest run per PR.
 *
 * Both dashboard features need this same walk over `chapter_run` — the inbox to
 * link a PR to its latest review, generation to find a clone to run the agent in.
 * Rows are read newest-generated-first, so the first row seen per key wins.
 */
export class RunIndex {
	private readonly repoRoots = new Map<string, string>();
	private readonly runIds = new Map<string, Map<number, string>>();

	constructor(db: StageDb) {
		const runs = db
			.select({
				id: chapterRun.id,
				repoRoot: chapterRun.repoRoot,
				originUrl: chapterRun.originUrl,
				prNumber: chapterRun.prNumber,
			})
			.from(chapterRun)
			.orderBy(desc(chapterRun.generatedAt))
			.all();

		for (const run of runs) {
			const repo = parseGitHubRepo(run.originUrl);
			if (!repo) continue;
			const nameWithOwner = toNameWithOwner(repo);
			if (!this.repoRoots.has(nameWithOwner)) this.repoRoots.set(nameWithOwner, run.repoRoot);
			if (run.prNumber === null) continue;
			let byPrNumber = this.runIds.get(nameWithOwner);
			if (!byPrNumber) {
				byPrNumber = new Map();
				this.runIds.set(nameWithOwner, byPrNumber);
			}
			if (!byPrNumber.has(run.prNumber)) byPrNumber.set(run.prNumber, run.id);
		}
	}

	/** Newest run for a PR, or null if Stage has never generated chapters for it. */
	runIdFor(nameWithOwner: string, prNumber: number): string | null {
		return this.runIds.get(nameWithOwner.toLowerCase())?.get(prNumber) ?? null;
	}

	/** A local clone of the repo Stage has generated from before, or null. */
	repoRootFor(nameWithOwner: string): string | null {
		return this.repoRoots.get(nameWithOwner.toLowerCase()) ?? null;
	}
}
