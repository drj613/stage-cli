import { asc, eq } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRunPullRequest } from "../db/schema/index.js";

/** A pull request a run reviews, before it has a run to belong to. */
export interface RunMember {
	prNumber: number;
	/** The member's head commit at generation time. */
	headSha: string;
}

/** A stored member, carrying its place in the stack. */
export interface StoredRunMember extends RunMember {
	/** 0 is the bottom of the stack. */
	position: number;
}

/** Members of a run in stack order, bottom first. Empty for a local run. */
export function listRunMembers(db: StageDb, runId: string): StoredRunMember[] {
	return db
		.select({
			prNumber: chapterRunPullRequest.prNumber,
			headSha: chapterRunPullRequest.headSha,
			position: chapterRunPullRequest.position,
		})
		.from(chapterRunPullRequest)
		.where(eq(chapterRunPullRequest.runId, runId))
		.orderBy(asc(chapterRunPullRequest.position))
		.all();
}

/** Just the PR numbers, in stack order. */
export function listRunPrNumbers(db: StageDb, runId: string): number[] {
	return listRunMembers(db, runId).map((m) => m.prNumber);
}
