import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { RunMember } from "../runs/run-members.js";
import { ghErrorMessage } from "./exec.js";

const execFileAsync = promisify(execFile);

/** True when `ancestor` is reachable from `descendant`. */
export type IsAncestor = (ancestor: string, descendant: string) => boolean;

/**
 * Put members in stack order and prove the order is real. Neither the command
 * line nor the chain graph is authoritative after a force-push, so ancestry
 * decides.
 *
 * Ordering is by ancestor count rather than a sort comparator: `isAncestor` is a
 * partial order, so a comparator built from one is not antisymmetric for a
 * broken stack, which leaves `Array.sort` engine-defined. Counting is
 * deterministic for every input.
 *
 * A member whose commits are not contained in the one above it would silently
 * vanish from the union diff, so this throws rather than dropping it.
 */
export function orderMembersByAncestry(
	members: readonly RunMember[],
	isAncestor: IsAncestor,
): RunMember[] {
	const seen = new Set<number>();
	for (const member of members) {
		if (seen.has(member.prNumber)) {
			throw new Error(`PR #${member.prNumber} was given twice.`);
		}
		seen.add(member.prNumber);
	}

	const ordered = members
		.map((member) => ({
			member,
			depth: members.filter(
				(other) => other.headSha !== member.headSha && isAncestor(other.headSha, member.headSha),
			).length,
		}))
		.sort((a, b) => a.depth - b.depth)
		.map((entry) => entry.member);

	for (let i = 0; i + 1 < ordered.length; i++) {
		const lower = ordered[i];
		const upper = ordered[i + 1];
		if (lower === undefined || upper === undefined) {
			throw new Error("ordered members contained a hole");
		}
		if (!isAncestor(lower.headSha, upper.headSha)) {
			throw new Error(
				`PR #${upper.prNumber} is not stacked on #${lower.prNumber}: ` +
					`#${lower.prNumber}'s commits are missing from #${upper.prNumber}. ` +
					"Restack the branch and try again.",
			);
		}
	}
	return ordered;
}

/** A local `git merge-base --is-ancestor` check, memoized per pair. */
export function gitIsAncestor(repoRoot: string): IsAncestor {
	const cache = new Map<string, Map<string, boolean>>();
	return (ancestor, descendant) => {
		let byDescendant = cache.get(ancestor);
		if (!byDescendant) {
			byDescendant = new Map();
			cache.set(ancestor, byDescendant);
		}
		const cached = byDescendant.get(descendant);
		if (cached !== undefined) return cached;
		let result: boolean;
		try {
			execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant], {
				stdio: ["ignore", "ignore", "ignore"],
			});
			result = true;
		} catch {
			result = false;
		}
		byDescendant.set(descendant, result);
		return result;
	};
}

async function runFetch(repoRoot: string, refs: readonly string[]): Promise<void> {
	if (refs.length === 0) throw new Error("fetch called with no refs");
	try {
		await execFileAsync("git", ["fetch", "--no-tags", "origin", ...refs], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch (err) {
		throw new Error(`Could not fetch ${refs.join(", ")}: ${ghErrorMessage(err)}`);
	}
}

/** Make every member's head available locally. */
export async function fetchStackHeads(
	repoRoot: string,
	prNumbers: readonly number[],
): Promise<void> {
	await runFetch(
		repoRoot,
		prNumbers.map((n) => `pull/${n}/head`),
	);
}

/**
 * Make one branch available locally. Called for the bottom member's base only
 * after ancestry ordering has identified which member that actually is.
 */
export async function fetchBranch(repoRoot: string, branch: string): Promise<void> {
	await runFetch(repoRoot, [branch]);
}
