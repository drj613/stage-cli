import { execFileSync } from "node:child_process";
import type { StoredRunMember } from "./run-members.js";

/**
 * Which pull requests changed each file, for a run that reviews a stack.
 *
 * A member's own contribution is the diff from the member below it to its own
 * head — not the whole stack — so the bottom member is diffed against the run's
 * base. Derived rather than stored: the run diff is already recomputed from
 * these same SHAs on every load, so persisting this would be a second source of
 * truth for the same fact.
 *
 * A member whose commits are unreadable (a branch pruned since the run) is
 * skipped rather than failing the request: the selector losing one option is
 * recoverable, an unusable composer is not.
 */
export function filePullRequests(
	repoRoot: string,
	members: readonly StoredRunMember[],
	baseSha: string,
): Map<string, number[]> {
	const byPath = new Map<string, number[]>();
	let previousSha = baseSha;
	for (const member of members) {
		for (const filePath of changedPaths(repoRoot, previousSha, member.headSha)) {
			const owners = byPath.get(filePath);
			if (owners) owners.push(member.prNumber);
			else byPath.set(filePath, [member.prNumber]);
		}
		previousSha = member.headSha;
	}
	return byPath;
}

function changedPaths(repoRoot: string, fromSha: string, toSha: string): string[] {
	try {
		const out = execFileSync(
			"git",
			["-C", repoRoot, "diff", "--name-only", "-z", `${fromSha}..${toSha}`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 10 * 1024 * 1024 },
		);
		return out.split("\0").filter((entry) => entry.length > 0);
	} catch {
		return [];
	}
}
