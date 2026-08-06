import { z } from "zod";
import { gh } from "./exec.js";
import type { StackListPr } from "./stack-index.js";

const STACK_FIELDS = "number,title,url,isDraft,isCrossRepository,headRefName,baseRefName";

/**
 * Deliberately larger than the dashboard's 50-PR list cap: a chain can reach
 * through PRs the list never shows. A result that hits this limit is reported
 * incomplete rather than guessed at.
 */
export const STACK_LIST_LIMIT = 100;

const StackPrSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	isDraft: z.boolean(),
	isCrossRepository: z.boolean(),
	headRefName: z.string().min(1),
	baseRefName: z.string().min(1),
});

export interface StackListResult {
	prs: StackListPr[];
	/** True when the result hit the limit, so the graph may be missing members. */
	capped: boolean;
}

/** Open PRs of one repo with the branch fields chains are built from. Throws on gh failure. */
export async function listStackPullRequests(
	nameWithOwner: string,
	cwd: string,
): Promise<StackListResult> {
	const stdout = await gh(
		[
			"pr",
			"list",
			"--repo",
			nameWithOwner,
			"--state",
			"open",
			"--limit",
			String(STACK_LIST_LIMIT),
			"--json",
			STACK_FIELDS,
		],
		cwd,
	);
	const prs = z.array(StackPrSchema).parse(JSON.parse(stdout));
	return { prs, capped: prs.length >= STACK_LIST_LIMIT };
}
