import { desc } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { parseGitHubRepo, toNameWithOwner } from "../github/repo.js";
import { listRunMembers, type StoredRunMember } from "../runs/run-members.js";

export interface StackRun {
	runId: string;
	members: StoredRunMember[];
}

/**
 * The newest run whose membership is exactly this chain. Exactly, not merely
 * overlapping: a run generated before a PR joined the chain reviewed a different
 * diff, so reusing it would present stale work as current.
 */
export function findStackRun(
	db: StageDb,
	nameWithOwner: string,
	prNumbers: readonly number[],
): StackRun | null {
	const wanted = nameWithOwner.toLowerCase();
	const runs = db
		.select({ id: chapterRun.id, originUrl: chapterRun.originUrl })
		.from(chapterRun)
		.orderBy(desc(chapterRun.generatedAt))
		.all();

	for (const run of runs) {
		const repo = parseGitHubRepo(run.originUrl);
		if (!repo || toNameWithOwner(repo).toLowerCase() !== wanted) continue;
		const members = listRunMembers(db, run.id);
		if (members.length !== prNumbers.length) continue;
		if (members.every((member, i) => member.prNumber === prNumbers[i])) {
			return { runId: run.id, members };
		}
	}
	return null;
}

/**
 * Members whose live head differs from the one the run was generated against.
 * A member whose live head could not be read is not reported as moved — the
 * same offline tolerance the single-PR resolver has.
 */
export function movedMembers(
	members: readonly StoredRunMember[],
	liveHeads: ReadonlyMap<number, string>,
): number[] {
	return members
		.filter((member) => {
			const live = liveHeads.get(member.prNumber);
			return live !== undefined && live !== member.headSha;
		})
		.map((member) => member.prNumber);
}
