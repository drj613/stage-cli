import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { gh, ghErrorMessage } from "./exec.js";
import { type GitHubRepo, parseGitHubRepo } from "./repo.js";

const execFileAsync = promisify(execFile);

/** The two endpoints a PR diff is computed between, resolved to local SHAs. */
export interface PullRequestRefs {
	number: number;
	/** Current tip of the PR's base branch — diffed against `headSha` through their merge base. */
	baseSha: string;
	/** The PR's head commit. */
	headSha: string;
}

const PR_VIEW_FIELDS = ["number", "headRefOid", "baseRefName"] as const;

const PrViewSchema = z.object({
	number: z.number(),
	headRefOid: z.string().regex(/^[0-9a-f]{40}$/i, "Expected a full commit SHA"),
	baseRefName: z.string().min(1),
});

// https://github.com/owner/repo/pull/123 (with optional .git, trailing path, query, or hash).
// `github.com` is anchored to a host boundary (start, after `@`, or after `//`) so look-alike
// hosts like `notgithub.com/owner/repo/pull/1` aren't accepted — mirrors parseGitHubRepo.
const PR_URL_RE = /(?:^|@|\/\/)github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/pull\/(\d+)/;
const PR_NUMBER_RE = /^#?(\d+)$/;

/** The repo and number a github.com PR URL points at. */
export interface PullRequestLocation extends GitHubRepo {
	number: number;
}

/** Parse `owner`, `repo`, and number out of a github.com PR URL, or null if it isn't one. */
export function parsePullRequestUrl(url: string): PullRequestLocation | null {
	const match = url.trim().match(PR_URL_RE);
	if (!match) return null;
	const [, owner, repo, num] = match;
	if (!owner || !repo || !num) return null;
	return { owner, repo, number: Number(num) };
}

/**
 * The canonical github.com URL for a PR location. `parsePullRequestUrl` accepts
 * decorated URLs (`/files`, `?diff=split`, `#discussion_r1`), so round-tripping
 * through this gives one spelling per PR — which is what callers key on.
 */
export function toPullRequestUrl(location: PullRequestLocation): string {
	return `https://github.com/${location.owner}/${location.repo}/pull/${location.number}`;
}

/**
 * Resolve a user-supplied PR reference (a bare number, `#123`, or a github.com
 * PR URL) to its number, validating that a URL points at the current repo —
 * the diff route reads file contents from the local clone, so a cross-repo PR
 * can't be rendered.
 */
export function parsePullRequestNumber(prRef: string, repo: GitHubRepo): number {
	const trimmed = prRef.trim();

	const location = parsePullRequestUrl(trimmed);
	if (location) {
		if (
			location.owner.toLowerCase() !== repo.owner.toLowerCase() ||
			location.repo.toLowerCase() !== repo.repo.toLowerCase()
		) {
			throw new Error(
				`PR ${location.owner}/${location.repo}#${location.number} is in a different repository than the current one (${repo.owner}/${repo.repo}). Run the CLI inside that repository instead.`,
			);
		}
		return location.number;
	}

	const numberMatch = trimmed.match(PR_NUMBER_RE);
	if (numberMatch?.[1]) return Number(numberMatch[1]);

	throw new Error(
		`Invalid PR reference "${prRef}". Expected a PR number (e.g. 123) or a github.com PR URL.`,
	);
}

function requireGitHubRepo(originUrl: string | null): GitHubRepo {
	const repo = parseGitHubRepo(originUrl);
	if (!repo) {
		throw new Error(
			"--pr requires a github.com origin remote, which the current repository doesn't have.",
		);
	}
	return repo;
}

/**
 * Validate the repo has a github.com origin and resolve a `--pr` reference to
 * its number. The single entry point for both PR-resolution paths — the
 * fetch-and-diff path ({@link resolvePullRequestRefs}) and the number-only path
 * used when the scope comes from elsewhere — so origin validation can't drift.
 */
export function parsePullRequestRef(originUrl: string | null, prRef: string): number {
	return parsePullRequestNumber(prRef, requireGitHubRepo(originUrl));
}

async function ghPrView(repoRoot: string, prNumber: number): Promise<z.infer<typeof PrViewSchema>> {
	let stdout: string;
	try {
		stdout = await gh(
			["pr", "view", String(prNumber), "--json", PR_VIEW_FIELDS.join(",")],
			repoRoot,
		);
	} catch (err) {
		throw new Error(`Could not load PR #${prNumber} via gh: ${ghErrorMessage(err)}`);
	}
	return PrViewSchema.parse(JSON.parse(stdout));
}

/**
 * Make the PR's head and base commits available locally. GitHub exposes a PR's
 * head at `refs/pull/<number>/head`; fetching it alongside the base branch
 * updates `origin/<baseRefName>` so both endpoints resolve.
 */
async function fetchPullRequest(
	repoRoot: string,
	prNumber: number,
	baseRefName: string,
): Promise<void> {
	try {
		await execFileAsync(
			"git",
			["fetch", "--no-tags", "origin", `pull/${prNumber}/head`, baseRefName],
			{ cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
		);
	} catch (err) {
		throw new Error(`Could not fetch PR #${prNumber} refs: ${ghErrorMessage(err)}`);
	}
}

async function revParse(repoRoot: string, ref: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", ref], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return stdout.trim();
}

/**
 * Resolve a PR reference to local base/head SHAs, fetching the PR's commits
 * into the clone so the diff and file-content reads downstream succeed. Throws
 * with an actionable message when the remote isn't GitHub, the reference is
 * malformed, or `gh`/`git` can't reach the PR — the user explicitly asked for
 * this PR, so failures surface rather than degrade.
 */
export async function resolvePullRequestRefs(
	repoRoot: string,
	originUrl: string | null,
	prRef: string,
): Promise<PullRequestRefs> {
	const prNumber = parsePullRequestRef(originUrl, prRef);
	const pr = await ghPrView(repoRoot, prNumber);
	await fetchPullRequest(repoRoot, pr.number, pr.baseRefName);
	const baseSha = await revParse(repoRoot, `origin/${pr.baseRefName}`);

	return { number: pr.number, baseSha, headSha: pr.headRefOid };
}
