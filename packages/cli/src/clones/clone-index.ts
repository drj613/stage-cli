import fs from "node:fs";
import path from "node:path";
import { parseGitHubRepo, toNameWithOwner } from "../github/repo.js";

const MAX_DEPTH = 4;
const SKIPPED_DIR = "node_modules";

export interface CloneOwner {
	owner: string;
	cloneCount: number;
}

/**
 * An in-memory map from lowercased `owner/repo` to a local clone path, built by
 * scanning the configured roots. Never persisted — a stale path pointing
 * generation at a moved clone is worse than rescanning (see design doc).
 */
export class CloneIndex {
	private constructor(private readonly paths: Map<string, string>) {}

	static empty(): CloneIndex {
		return new CloneIndex(new Map());
	}

	/**
	 * Walk each root breadth-first to MAX_DEPTH, stopping descent at any
	 * directory that is itself a repo, skipping node_modules and dot-dirs.
	 * Reads .git/config directly — no git subprocess per repo.
	 */
	static scan(roots: string[]): CloneIndex {
		const paths = new Map<string, string>();
		const visited = new Set<string>();
		const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
		// Index-based BFS cursor — shift() on a large queue is O(n²).
		for (let head = 0; head < queue.length; head++) {
			const entry = queue[head];
			if (entry === undefined) continue; // noUncheckedIndexedAccess; unreachable by construction
			const { dir, depth } = entry;
			const isRoot = depth === 0;
			let real: string;
			try {
				real = fs.realpathSync(dir);
			} catch (error) {
				if (isRoot) warnUnscannableRoot(dir, error);
				continue; // broken symlink or vanished directory
			}
			if (visited.has(real)) continue; // symlink loop
			visited.add(real);

			const probe = probeRepo(dir, isRoot);
			if (probe.isRepo) {
				// A repo — GitHub or not, origin readable or not — never descend
				// into it. Repo-ness comes from the presence of a `.git` entry,
				// not from whether an origin url could be parsed.
				if (probe.originUrl !== null) {
					const repo = parseGitHubRepo(probe.originUrl);
					if (repo) {
						const key = toNameWithOwner(repo);
						if (!paths.has(key)) paths.set(key, dir);
					}
				}
				continue;
			}

			if (depth >= MAX_DEPTH) continue;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch (error) {
				if (isRoot) warnUnscannableRoot(dir, error);
				continue; // unreadable directory — skip, don't abort the scan
			}
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				if (entry.name === SKIPPED_DIR || entry.name.startsWith(".")) continue;
				queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
			}
		}
		return new CloneIndex(paths);
	}

	pathFor(nameWithOwner: string): string | null {
		return this.paths.get(nameWithOwner.toLowerCase()) ?? null;
	}

	get size(): number {
		return this.paths.size;
	}

	owners(): CloneOwner[] {
		const counts = new Map<string, number>();
		for (const key of this.paths.keys()) {
			const owner = key.split("/")[0];
			if (!owner) continue;
			counts.set(owner, (counts.get(owner) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([owner, cloneCount]) => ({ owner, cloneCount }))
			.sort((a, b) => a.owner.localeCompare(b.owner));
	}
}

type RepoProbe = { isRepo: false } | { isRepo: true; originUrl: string | null };

/**
 * Whether `dir` is a repo working tree, and if so its origin url (null when
 * the origin is absent, non-literal, or unreadable). Repo-ness and origin are
 * separate answers on purpose: a repo whose origin can't be read must still
 * stop descent — conflating the two would send the scanner into working trees
 * (vendored clones, include.path configs) it promised never to enter.
 *
 * A `.git` file (linked worktree) is followed via its `gitdir:` pointer and
 * then that directory's `commondir` file — the real config lives beside the
 * common dir, not in `.git/worktrees/<name>`. Bare clones have no `.git`
 * entry, so they never match here.
 *
 * `isRoot` marks a directory the user explicitly configured as a scan root —
 * a read failure there is warned about (see `warnUnscannableRoot`), while the
 * same failure on a directory discovered deeper in the tree stays silent.
 */
function probeRepo(dir: string, isRoot: boolean): RepoProbe {
	const gitEntry = path.join(dir, ".git");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(gitEntry);
	} catch {
		return { isRepo: false };
	}
	let configPath: string | null;
	if (stat.isDirectory()) {
		configPath = path.join(gitEntry, "config");
	} else {
		const commonDir = resolveWorktreeCommonDir(dir, gitEntry, isRoot);
		configPath = commonDir === null ? null : path.join(commonDir, "config");
	}
	if (configPath === null) return { isRepo: true, originUrl: null };
	let config: string;
	try {
		config = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		if (isRoot) warnUnscannableRoot(dir, error);
		return { isRepo: true, originUrl: null };
	}
	return { isRepo: true, originUrl: parseOriginUrl(config) };
}

function resolveWorktreeCommonDir(dir: string, gitFile: string, isRoot: boolean): string | null {
	try {
		const pointer = fs.readFileSync(gitFile, "utf8").trim();
		const match = pointer.match(/^gitdir:\s*(.+)$/);
		if (!match?.[1]) return null;
		const gitDir = path.resolve(dir, match[1]);
		const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
		return path.resolve(gitDir, commonDir);
	} catch (error) {
		if (isRoot) warnUnscannableRoot(dir, error);
		return null;
	}
}

/**
 * A user-configured clone root that couldn't be scanned (missing, unmounted,
 * or unreadable). Failures on directories discovered deeper in the tree are
 * expected — permission bits vary across a large clone — so only the root
 * itself, which the user explicitly chose, is worth surfacing.
 */
function warnUnscannableRoot(dir: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`Clone root is not scannable: ${dir} — ${message}`);
}

/**
 * A literal `url =` inside `[remote "origin"]`, quoted or bare — an inline
 * comment after the value is not stripped, so a config using one resolves to
 * a null origin. Deliberately capped: urls arriving via include.path /
 * includeIf are skipped rather than half-understood (see design doc — a full
 * INI parser isn't worth the dep).
 */
export function parseOriginUrl(config: string): string | null {
	let inOrigin = false;
	for (const raw of config.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			const section = line.match(/^\[remote\s+"([^"]*)"\]$/i);
			// The `remote` keyword is case-insensitive; git subsection names
			// ("origin" vs "Origin") are not, so compare that literally.
			inOrigin = section?.[1] === "origin";
			continue;
		}
		if (!inOrigin) continue;
		const match = line.match(/^url\s*=\s*"?([^"]+?)"?\s*$/);
		if (match?.[1]) return match[1];
	}
	return null;
}
