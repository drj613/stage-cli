import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ChapterRunRow } from "./db/schema/chapter-run.js";
import { SCOPE_KIND, type Scope, WORKING_TREE_REF, type WorkingTreeRef } from "./schema.js";

export class NotInGitRepoError extends Error {
	constructor() {
		super("stage-cli must be run inside a git repository");
		this.name = "NotInGitRepoError";
	}
}

/**
 * Snapshot of the git context a chapter run was generated against. Captured
 * at import time and stored on `chapter_run` so the run keeps reading
 * consistently even if the repo's remote is later renamed or detached.
 */
export interface RepoContext {
	/** Absolute path to the worktree root (`git rev-parse --show-toplevel`). */
	root: string;
	/** `origin` remote URL, or null when no `origin` is configured. */
	originUrl: string | null;
}

export function readRepoContext(cwd: string): RepoContext {
	const root = readRepoRoot(cwd);
	return { root, originUrl: readOriginUrl(root) };
}

/** Discover the worktree root containing `cwd`. */
export function readRepoRoot(cwd: string): string {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		throw new NotInGitRepoError();
	}
}

function readOriginUrl(repoRoot: string): string | null {
	try {
		const out = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

/** Configured `user.name` for the repo, or null when unset. Used as a viewer-identity fallback. */
export function readGitUserName(repoRoot: string): string | null {
	try {
		const out = execFileSync("git", ["-C", repoRoot, "config", "user.name"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

export function buildDiffArgs(run: ChapterRunRow): string[] {
	if (run.scopeKind === SCOPE_KIND.COMMITTED) {
		return ["diff", "--no-color", `${run.baseSha}..${run.headSha}`];
	}
	if (run.workingTreeRef === null) {
		throw new Error("workingTree run is missing workingTreeRef");
	}
	switch (run.workingTreeRef) {
		case WORKING_TREE_REF.UNSTAGED:
			return ["diff", "--no-color"];
		case WORKING_TREE_REF.STAGED:
			return ["diff", "--no-color", "--cached"];
		case WORKING_TREE_REF.WORK:
			return ["diff", "--no-color", run.baseSha];
	}
}

/**
 * Derive the repo's display name from its origin URL, falling back to the
 * worktree directory's basename when the URL is missing or unparseable.
 *
 * Handles the URL shapes git emits in practice:
 *   git@github.com:owner/repo(.git)
 *   https://github.com/owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 */
export function parseRepoName(originUrl: string | null, repoRoot: string): string {
	if (originUrl) {
		const trimmed = originUrl.replace(/\.git$/, "");
		const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
		const segment = trimmed.slice(lastSeparator + 1);
		if (segment) return segment;
	}
	return path.basename(repoRoot);
}

export function detectBaseRef(cwd: string): string {
	const candidates: string[][] = [
		["rev-parse", "--abbrev-ref", "origin/HEAD"],
		["rev-parse", "--verify", "main"],
		["rev-parse", "--verify", "master"],
		["rev-parse", "--verify", "origin/main"],
		["rev-parse", "--verify", "origin/master"],
	];

	for (const args of candidates) {
		try {
			const out = execFileSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (out) return out;
		} catch {
			// try next candidate
		}
	}

	throw new Error(
		"No default branch detected. Tried origin/HEAD, main, master, origin/main, and origin/master.",
	);
}

export function resolveMergeBase(cwd: string, base: string): string {
	return execFileSync("git", ["-C", cwd, "merge-base", base, "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

export function resolveHead(cwd: string): string {
	return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

export function getRawDiff(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-C", cwd, "diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", ...args],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 50 * 1024 * 1024,
		},
	);
}

export function getUntrackedFiles(cwd: string): string[] {
	const out = execFileSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	return out ? out.split("\n") : [];
}

export function hasStringStdout(err: unknown): err is { stdout: string } {
	return (
		typeof err === "object" && err !== null && "stdout" in err && typeof err.stdout === "string"
	);
}

export function getUntrackedDiff(cwd: string, files: string[]): string {
	const patches: string[] = [];
	for (const file of files) {
		try {
			execFileSync(
				"git",
				[
					"-C",
					cwd,
					"diff",
					"--no-index",
					"--no-color",
					"--src-prefix=a/",
					"--dst-prefix=b/",
					"--",
					"/dev/null",
					file,
				],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					maxBuffer: 50 * 1024 * 1024,
				},
			);
		} catch (err: unknown) {
			if (hasStringStdout(err)) {
				patches.push(err.stdout);
			}
		}
	}
	return patches.join("\n");
}

export function getCommitMessages(cwd: string, mergeBase: string, head: string): string {
	return execFileSync("git", ["-C", cwd, "log", "--oneline", `${mergeBase}..${head}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

export function hasUncommittedChanges(cwd: string): boolean {
	const out = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	return out.length > 0;
}

export interface ResolvedScope {
	scope: Scope;
	mergeBaseSha: string;
	rawDiff: string;
}

export interface ResolveScopeOptions {
	/**
	 * Directory every git command runs in. Callers that already know the repo
	 * (the generation daemon) pass its root; the CLI passes `process.cwd()`.
	 */
	cwd: string;
	base?: string;
	compare?: string;
	refs?: string[];
	workingTreeRef?: WorkingTreeRef;
}

const RANGE_SEPARATOR = {
	TWO_DOT: "..",
	THREE_DOT: "...",
} as const;

interface RefRange {
	left: string;
	right: string;
}

function workingTreeDiffArgs(ref: WorkingTreeRef, mergeBaseSha: string): string[] {
	switch (ref) {
		case WORKING_TREE_REF.UNSTAGED:
			return [];
		case WORKING_TREE_REF.STAGED:
			return ["--cached"];
		case WORKING_TREE_REF.WORK:
			return [mergeBaseSha];
	}
}

function includesUntrackedFiles(ref: WorkingTreeRef): boolean {
	return ref === WORKING_TREE_REF.WORK;
}

function buildWorkingTreeDiff(cwd: string, ref: WorkingTreeRef, mergeBaseSha: string): string {
	let rawDiff = getRawDiff(cwd, workingTreeDiffArgs(ref, mergeBaseSha));
	if (includesUntrackedFiles(ref)) {
		const untrackedFiles = getUntrackedFiles(cwd);
		if (untrackedFiles.length > 0) {
			const untrackedDiff = getUntrackedDiff(cwd, untrackedFiles);
			if (untrackedDiff) {
				rawDiff = rawDiff ? `${rawDiff}\n${untrackedDiff}` : untrackedDiff;
			}
		}
	}
	return rawDiff;
}

function resolveRefToSha(cwd: string, ref: string): string {
	return execFileSync("git", ["-C", cwd, "rev-parse", "--verify", ref], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function canResolveRef(cwd: string, ref: string): boolean {
	try {
		resolveRefToSha(cwd, ref);
		return true;
	} catch {
		return false;
	}
}

function resolveMergeBaseBetween(cwd: string, left: string, right: string): string {
	return execFileSync("git", ["-C", cwd, "merge-base", left, right], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function parseRefRange(ref: string): RefRange | null {
	const threeDotIndex = ref.indexOf(RANGE_SEPARATOR.THREE_DOT);
	if (threeDotIndex !== -1) {
		return {
			left: ref.slice(0, threeDotIndex),
			right: ref.slice(threeDotIndex + RANGE_SEPARATOR.THREE_DOT.length),
		};
	}

	const twoDotIndex = ref.indexOf(RANGE_SEPARATOR.TWO_DOT);
	if (twoDotIndex !== -1) {
		return {
			left: ref.slice(0, twoDotIndex),
			right: ref.slice(twoDotIndex + RANGE_SEPARATOR.TWO_DOT.length),
		};
	}

	return null;
}

export function resolveCommittedComparison(
	cwd: string,
	left: string,
	right: string,
): ResolvedScope {
	const effectiveLeft = left || "HEAD";
	const effectiveRight = right || "HEAD";

	const mergeBaseSha = resolveMergeBaseBetween(cwd, effectiveLeft, effectiveRight);
	const headSha = resolveRefToSha(cwd, effectiveRight);

	return {
		scope: {
			kind: SCOPE_KIND.COMMITTED,
			baseSha: mergeBaseSha,
			headSha,
			mergeBaseSha,
		},
		mergeBaseSha,
		rawDiff: getRawDiff(cwd, [`${mergeBaseSha}..${headSha}`]),
	};
}

function parseWorkingTreeRefArg(ref: string): WorkingTreeRef | null {
	switch (ref) {
		case ".":
		case WORKING_TREE_REF.WORK:
			return WORKING_TREE_REF.WORK;
		case WORKING_TREE_REF.STAGED:
			return WORKING_TREE_REF.STAGED;
		case WORKING_TREE_REF.UNSTAGED:
			return WORKING_TREE_REF.UNSTAGED;
		default:
			return null;
	}
}

function resolveSingleRefScope(
	cwd: string,
	base: string,
	workingTreeRef?: WorkingTreeRef,
): ResolvedScope {
	const mergeBaseSha = resolveMergeBase(cwd, base);
	const headSha = resolveHead(cwd);

	const effectiveRef =
		workingTreeRef ?? (hasUncommittedChanges(cwd) ? WORKING_TREE_REF.WORK : null);

	if (effectiveRef) {
		return {
			scope: {
				kind: SCOPE_KIND.WORKING_TREE,
				ref: effectiveRef,
				baseSha: mergeBaseSha,
				headSha,
				mergeBaseSha,
			},
			mergeBaseSha,
			rawDiff: buildWorkingTreeDiff(cwd, effectiveRef, mergeBaseSha),
		};
	}

	return {
		scope: {
			kind: SCOPE_KIND.COMMITTED,
			baseSha: mergeBaseSha,
			headSha,
			mergeBaseSha,
		},
		mergeBaseSha,
		rawDiff: getRawDiff(cwd, [`${mergeBaseSha}..${headSha}`]),
	};
}

export function resolveScope(options: ResolveScopeOptions): ResolvedScope {
	const { cwd } = options;
	const refs = options.refs === undefined ? [] : options.refs;
	if (refs.length > 2) {
		throw new Error("Expected at most two git ref arguments.");
	}
	if (refs.length > 0 && (options.base !== undefined || options.compare !== undefined)) {
		throw new Error("Cannot use --base/--compare with positional git ref arguments.");
	}
	if (refs.length > 0 && options.workingTreeRef !== undefined) {
		throw new Error("Cannot use --ref with positional git ref arguments.");
	}
	if (options.compare !== undefined && options.workingTreeRef !== undefined) {
		throw new Error("Cannot use --compare with --ref.");
	}

	if (options.compare !== undefined) {
		if (options.base === undefined) {
			throw new Error("--compare requires --base.");
		}
		return resolveCommittedComparison(cwd, options.base, options.compare);
	}

	if (refs.length === 2) {
		const left = refs[0];
		const right = refs[1];
		if (left === undefined || right === undefined) {
			throw new Error("Expected both base and compare refs.");
		}
		return resolveCommittedComparison(cwd, left, right);
	}

	if (refs.length === 1) {
		const ref = refs[0];
		if (ref === undefined) {
			throw new Error("Expected a git ref argument.");
		}

		const range = parseRefRange(ref);
		if (range) return resolveCommittedComparison(cwd, range.left, range.right);

		if (!canResolveRef(cwd, ref)) {
			const workingTreeRef = parseWorkingTreeRefArg(ref);
			if (workingTreeRef) {
				return resolveSingleRefScope(cwd, detectBaseRef(cwd), workingTreeRef);
			}
		}

		return resolveSingleRefScope(cwd, ref);
	}

	const base = options.base === undefined ? detectBaseRef(cwd) : options.base;
	return resolveSingleRefScope(cwd, base, options.workingTreeRef);
}
