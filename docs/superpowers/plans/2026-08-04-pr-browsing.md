# PR Browsing & On-Demand Chaptering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three PR lists on the dashboard (review-requested, assigned, authored), a browse tier over the user's orgs, a stable `/pr/$owner/$repo/$number` URL per PR that resolves to the newest run or generates chapters on the spot, and clone-root management so Stage can find local clones beyond repos it has already run in.

**Architecture:** A new `clones/` module in the CLI (a `clone_root` SQLite table, a filesystem `CloneIndex` scanner, a `CloneRegistry` that owns both and is the single repo-root resolver). `github/inbox.ts` generalizes to `pr-search.ts` with a filter parameter. New routes for PR lists, browse, PR resolution (a six-state discriminated union), and clone roots. The frontend adds a resolver page, browse pages, a settings page, and dashboard sections.

**Tech Stack:** Node 20 ESM, Commander, Drizzle + better-sqlite3, Zod, plain `node:http` routes, React 19 + TanStack Router/Query, Vitest.

**Design doc:** `docs/superpowers/2026-08-04-pr-browsing-design.md` — read it before starting. Its Decisions table is binding.

**Conventions that apply to every task:** tabs, double quotes, `import type`, no `as` assertions, no `any`, `noUncheckedIndexedAccess` is on. Run `pnpm typecheck && pnpm lint && pnpm test` before every commit. Test files max 200 lines — split by behavior group when needed.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `packages/cli/src/db/schema/clone-root.ts` | create | `clone_root` table |
| `packages/cli/drizzle/0008_*.sql` | generate | migration (via `pnpm db:generate`) |
| `packages/cli/src/clones/clone-root-store.ts` | create | CRUD + boundary validation for roots |
| `packages/cli/src/clones/clone-index.ts` | create | filesystem scan → `owner/repo → path` map |
| `packages/cli/src/clones/clone-registry.ts` | create | owns store + index; `resolveRepoRoot` |
| `packages/cli/src/github/pr-search.ts` | create (from `inbox.ts`) | `searchPullRequests(filter)` + `mapSearchResults` |
| `packages/cli/src/github/inbox.ts` | delete | replaced by `pr-search.ts` |
| `packages/cli/src/github/repos.ts` | create | `listOrgRepos` via `gh repo list` |
| `packages/cli/src/github/pr-list.ts` | create | `listRepoPullRequests` via `gh pr list` |
| `packages/cli/src/generation/job-manager.ts` | modify | `latestJobFor`, `queuePosition` |
| `packages/cli/src/runs/run-index.ts` | modify | `latestRunFor` returning `{runId, headSha}` |
| `packages/cli/src/routes/pull-requests.ts` | create | list + resolution endpoints |
| `packages/cli/src/routes/inbox.ts` | delete | replaced by `pull-requests.ts` |
| `packages/cli/src/routes/browse.ts` | create | owners / owner repos / repo pulls |
| `packages/cli/src/routes/clone-roots.ts` | create | root CRUD + rescan |
| `packages/cli/src/routes/generate.ts` | modify | resolve via registry; `queuePosition` in GET |
| `packages/cli/src/routes/core.ts` | modify | wire registry + new routes |
| `packages/cli/src/start.ts`, `show.ts`, `index.ts` | modify | build registry; `config` subcommands |
| `packages/types/src/pull-requests.ts` | create | `PR_FILTER`, `PR_RESOLUTION`, row + resolution schemas |
| `packages/types/src/browse.ts` | create | owners/repos wire schemas |
| `packages/types/src/clone-roots.ts` | create | roots + rescan wire schemas |
| `packages/types/src/generation.ts` | modify | `queuePosition` on `GenerationJobSchema` |
| `packages/types/src/inbox.ts` | delete | replaced by `pull-requests.ts` |
| `packages/web/src/lib/use-pull-requests.ts` | create | list hook (from `use-inbox.ts`) |
| `packages/web/src/lib/use-pr-resolution.ts` | create | resolver state machine (absorbs `useChapterGeneration`) |
| `packages/web/src/lib/use-browse.ts` | create | browse hooks |
| `packages/web/src/lib/use-clone-roots.ts` | create | roots hooks |
| `packages/web/src/lib/dedupe-pull-requests.ts` | create | pure top-down dedupe |
| `packages/web/src/lib/use-inbox.ts` | delete | absorbed |
| `packages/web/src/components/dashboard/pull-request-list.tsx` | create | one section, parameterized by rows |
| `packages/web/src/components/dashboard/inbox-list.tsx` | delete | replaced |
| `packages/web/src/components/dashboard/onboarding-card.tsx` | create | zero-roots nudge |
| `packages/web/src/app/index.tsx` | modify | 3 PR sections + dedupe + onboarding |
| `packages/web/src/app/pr.$owner.$repo.$number.tsx` | create | resolver page |
| `packages/web/src/app/browse.index.tsx`, `browse.$owner.index.tsx`, `browse.$owner.$repo.tsx` | create | browse pages |
| `packages/web/src/app/settings.tsx` | create | clone roots UI |
| `packages/web/src/components/layout/topbar.tsx` | modify | Browse + Settings links |

---

### Task 1: `clone_root` table, migration, and store

**Files:**
- Create: `packages/cli/src/db/schema/clone-root.ts`
- Modify: `packages/cli/src/db/schema/index.ts`
- Create: `packages/cli/src/clones/clone-root-store.ts`
- Test: `packages/cli/src/__tests__/clone-root-store.test.ts`
- Generate: `packages/cli/drizzle/0008_*.sql`

- [ ] **Step 1: Write the schema**

`packages/cli/src/db/schema/clone-root.ts`:

```ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A directory Stage scans for local git clones. One row per configured search root. */
export const cloneRoot = sqliteTable("clone_root", {
	path: text().primaryKey(),
	addedAt: integer({ mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.notNull(),
});

export type CloneRootRow = typeof cloneRoot.$inferSelect;
```

Add `export * from "./clone-root.js";` to `packages/cli/src/db/schema/index.ts` (keep alphabetical order among the existing exports).

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/cli/drizzle/0008_*.sql` containing `CREATE TABLE \`clone_root\``. Commit it together with the schema.

- [ ] **Step 3: Write failing store tests**

`packages/cli/src/__tests__/clone-root-store.test.ts` — real temp SQLite via `getDb({ dbPath })` like other DB tests:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCloneRoot, listCloneRoots, removeCloneRoot } from "../clones/clone-root-store.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";

let tmpDir = "";
let db: StageDb;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-clone-roots-"));
	closeDb();
	db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
});

afterEach(async () => {
	closeDb();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("clone-root-store", () => {
	it("round-trips add, list, and remove", async () => {
		const root = path.join(tmpDir, "code");
		await fs.mkdir(root);
		addCloneRoot(db, root);
		expect(listCloneRoots(db).map((r) => r.path)).toEqual([root]);
		removeCloneRoot(db, root);
		expect(listCloneRoots(db)).toEqual([]);
	});

	it("is idempotent when the same root is added twice", async () => {
		const root = path.join(tmpDir, "code");
		await fs.mkdir(root);
		addCloneRoot(db, root);
		addCloneRoot(db, root);
		expect(listCloneRoots(db)).toHaveLength(1);
	});

	it("rejects relative paths", () => {
		expect(() => addCloneRoot(db, "code")).toThrow(/absolute/);
	});

	it("rejects paths that are not directories", async () => {
		const file = path.join(tmpDir, "a-file");
		await fs.writeFile(file, "");
		expect(() => addCloneRoot(db, file)).toThrow(/not a directory/);
	});

	it("rejects paths that do not exist", () => {
		expect(() => addCloneRoot(db, path.join(tmpDir, "missing"))).toThrow(/does not exist/);
	});
});
```

Run: `pnpm vitest run packages/cli/src/__tests__/clone-root-store.test.ts`
Expected: FAIL — module `../clones/clone-root-store.js` does not exist.

- [ ] **Step 4: Implement the store**

`packages/cli/src/clones/clone-root-store.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { cloneRoot, type CloneRootRow } from "../db/schema/index.js";

export function listCloneRoots(db: StageDb): CloneRootRow[] {
	return db.select().from(cloneRoot).orderBy(asc(cloneRoot.addedAt)).all();
}

/**
 * Register a search root. Validated at this boundary — a typo'd root silently
 * yielding zero repos is worse than failing loudly on add.
 */
export function addCloneRoot(db: StageDb, rootPath: string): void {
	if (!path.isAbsolute(rootPath)) {
		throw new Error(`Clone root must be an absolute path: ${rootPath}`);
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(rootPath);
	} catch {
		throw new Error(`Clone root does not exist: ${rootPath}`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`Clone root is not a directory: ${rootPath}`);
	}
	db.insert(cloneRoot).values({ path: rootPath }).onConflictDoNothing().run();
}

export function removeCloneRoot(db: StageDb, rootPath: string): void {
	db.delete(cloneRoot).where(eq(cloneRoot.path, rootPath)).run();
}
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run packages/cli/src/__tests__/clone-root-store.test.ts` → PASS, then `pnpm typecheck && pnpm lint`.

```bash
git add packages/cli/src/db/schema packages/cli/drizzle packages/cli/src/clones packages/cli/src/__tests__/clone-root-store.test.ts
git commit -m "feat: add clone_root table and store"
```

---

### Task 2: `CloneIndex` — the filesystem scanner

**Files:**
- Create: `packages/cli/src/clones/clone-index.ts`
- Test: `packages/cli/src/__tests__/clone-index.test.ts`

This is the trickiest pure logic in the plan. Read the design doc's `clone-index.ts` section first. Key behaviors: BFS bounded at depth 4, stop descending into a directory that is itself a repo, skip `node_modules` and dot-directories, read `.git/config` directly (no git subprocess), handle a `.git` *file* via `gitdir:` → `commondir` hop, skip bare clones / non-GitHub remotes / configs without a literal origin url (but still stop descent at any repo, origin readable or not — repo-ness is the presence of a `.git` entry, not a parseable origin), lowercase keys, survive symlink loops and unreadable directories.

The scan is deliberately synchronous, which blocks the HTTP server while it runs. That's an accepted trade: roots are user-chosen code directories, depth is capped at 4, and dot-dirs/`node_modules` are skipped, so a scan is expected to finish in well under a second — and sync-ness is what makes concurrent rescans structurally impossible (Task 3). If a user points Stage at a pathological root (a network mount, `$HOME` with millions of dirs), the rescan request is the thing that hangs; that bounded-root restriction is the documented contract, not something to engineer around.

- [ ] **Step 1: Write failing tests against fixture trees**

A helper builds fake repos in a temp dir — no real `git` needed, a repo is just a directory with a `.git/config`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloneIndex } from "../clones/clone-index.js";

let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "stage-clone-index-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A fake clone: a directory holding .git/config with the given origin url. */
async function makeRepo(rel: string, originUrl: string): Promise<string> {
	const dir = path.join(root, rel);
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.writeFile(
		path.join(dir, ".git", "config"),
		`[core]\n\tbare = false\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
	);
	return dir;
}

describe("CloneIndex.scan", () => {
	it("maps origin urls to lowercased owner/repo keys", async () => {
		const dir = await makeRepo("Acme/API", "git@github.com:Acme/API.git");
		const index = CloneIndex.scan([root]);
		expect(index.pathFor("acme/api")).toBe(dir);
		expect(index.pathFor("Acme/API")).toBe(dir);
	});

	it("merges mixed-case remote urls into one key and one owner", async () => {
		await makeRepo("a", "https://github.com/Acme/one.git");
		await makeRepo("b", "https://github.com/acme/two");
		const index = CloneIndex.scan([root]);
		expect(index.owners()).toEqual([{ owner: "acme", cloneCount: 2 }]);
	});

	it("does not descend into a repo looking for nested repos", async () => {
		const outer = await makeRepo("outer", "https://github.com/o/outer");
		await makeRepo("outer/vendor/inner", "https://github.com/o/inner");
		const index = CloneIndex.scan([root]);
		expect(index.pathFor("o/outer")).toBe(outer);
		expect(index.pathFor("o/inner")).toBeNull();
	});

	it("skips node_modules and dot-directories", async () => {
		await makeRepo("node_modules/dep", "https://github.com/o/dep");
		await makeRepo(".cache/repo", "https://github.com/o/cached");
		const index = CloneIndex.scan([root]);
		expect(index.pathFor("o/dep")).toBeNull();
		expect(index.pathFor("o/cached")).toBeNull();
	});

	it("skips repos deeper than the depth bound", async () => {
		await makeRepo("a/b/c/d/deep", "https://github.com/o/deep");
		expect(CloneIndex.scan([root]).pathFor("o/deep")).toBeNull();
	});

	it("skips non-GitHub remotes", async () => {
		await makeRepo("gl", "git@gitlab.com:o/r.git");
		expect(CloneIndex.scan([root]).owners()).toEqual([]);
	});

	it("skips bare clones (no .git working-tree entry)", async () => {
		const bare = path.join(root, "bare.git");
		await fs.mkdir(bare, { recursive: true });
		await fs.writeFile(
			path.join(bare, "config"),
			`[core]\n\tbare = true\n[remote "origin"]\n\turl = https://github.com/o/bare\n`,
		);
		expect(CloneIndex.scan([root]).pathFor("o/bare")).toBeNull();
	});

	it("skips configs whose origin url is only reachable via include.path", async () => {
		const dir = path.join(root, "included");
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		await fs.writeFile(path.join(dir, ".git", "config"), `[include]\n\tpath = ../extra\n`);
		expect(CloneIndex.scan([root]).owners()).toEqual([]);
	});

	it("resolves a linked worktree via the gitdir → commondir hop", async () => {
		// The main clone lives OUTSIDE the scanned root — the only way o/wt can
		// resolve is through the linked worktree's .git file. (A main clone inside
		// the root would make this test pass even with the hop completely broken.)
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stage-wt-main-"));
		try {
			const main = path.join(outside, "main");
			await fs.mkdir(path.join(main, ".git"), { recursive: true });
			await fs.writeFile(
				path.join(main, ".git", "config"),
				`[remote "origin"]\n\turl = https://github.com/o/wt\n`,
			);
			const wtGitDir = path.join(main, ".git", "worktrees", "feature");
			await fs.mkdir(wtGitDir, { recursive: true });
			await fs.writeFile(path.join(wtGitDir, "commondir"), "../..\n");
			const linked = path.join(root, "linked");
			await fs.mkdir(linked);
			await fs.writeFile(path.join(linked, ".git"), `gitdir: ${wtGitDir}\n`);
			const index = CloneIndex.scan([root]);
			expect(index.pathFor("o/wt")).toBe(linked);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("does not descend into a repo whose origin is unreadable", async () => {
		// A repo with an include.path-only config is still a repo — the scanner
		// must not descend into it and index vendored clones inside.
		const dir = path.join(root, "opaque");
		await fs.mkdir(path.join(dir, ".git"), { recursive: true });
		await fs.writeFile(path.join(dir, ".git", "config"), `[include]\n\tpath = ../extra\n`);
		await makeRepo("opaque/vendor/inner", "https://github.com/o/inner");
		expect(CloneIndex.scan([root]).pathFor("o/inner")).toBeNull();
	});

	it("terminates on symlink loops", async () => {
		const a = path.join(root, "a");
		await fs.mkdir(a);
		await fs.symlink(root, path.join(a, "loop"), "dir");
		expect(() => CloneIndex.scan([root])).not.toThrow();
	});

	it("skips unreadable directories instead of aborting", async () => {
		const locked = path.join(root, "locked");
		await fs.mkdir(locked);
		const ok = await makeRepo("ok", "https://github.com/o/ok");
		await fs.chmod(locked, 0o000);
		try {
			expect(CloneIndex.scan([root]).pathFor("o/ok")).toBe(ok);
		} finally {
			await fs.chmod(locked, 0o755);
		}
	});
});
```

If this exceeds 200 lines, split into `clone-index.test.ts` (mapping/keys/owners) and `clone-index-hazards.test.ts` (worktrees, loops, permissions, depth).

Run: `pnpm vitest run packages/cli/src/__tests__/clone-index.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `CloneIndex`**

`packages/cli/src/clones/clone-index.ts`:

```ts
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
			let real: string;
			try {
				real = fs.realpathSync(dir);
			} catch {
				continue; // broken symlink or vanished directory
			}
			if (visited.has(real)) continue; // symlink loop
			visited.add(real);

			const probe = probeRepo(dir);
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
			} catch {
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
 */
function probeRepo(dir: string): RepoProbe {
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
		const commonDir = resolveWorktreeCommonDir(dir, gitEntry);
		configPath = commonDir === null ? null : path.join(commonDir, "config");
	}
	if (configPath === null) return { isRepo: true, originUrl: null };
	let config: string;
	try {
		config = fs.readFileSync(configPath, "utf8");
	} catch {
		return { isRepo: true, originUrl: null };
	}
	return { isRepo: true, originUrl: parseOriginUrl(config) };
}

function resolveWorktreeCommonDir(dir: string, gitFile: string): string | null {
	try {
		const pointer = fs.readFileSync(gitFile, "utf8").trim();
		const match = pointer.match(/^gitdir:\s*(.+)$/);
		if (!match?.[1]) return null;
		const gitDir = path.resolve(dir, match[1]);
		const commonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
		return path.resolve(gitDir, commonDir);
	} catch {
		return null;
	}
}

/**
 * A literal `url =` inside `[remote "origin"]`, quoted or bare. Deliberately
 * capped: urls arriving via include.path / includeIf are skipped rather than
 * half-understood (see design doc — a full INI parser isn't worth the dep).
 */
export function parseOriginUrl(config: string): string | null {
	let inOrigin = false;
	for (const raw of config.split("\n")) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
			continue;
		}
		if (!inOrigin) continue;
		const match = line.match(/^url\s*=\s*"?([^"]+?)"?\s*$/);
		if (match?.[1]) return match[1];
	}
	return null;
}
```

Note the bare-clone test passes because a bare clone's config lives at `bare.git/config`, not `bare.git/.git/config` — `probeRepo` never finds a `.git` entry, and descending into the bare dir finds no repos either.

- [ ] **Step 3: Verify and commit**

Run: `pnpm vitest run packages/cli/src/__tests__/clone-index*.test.ts` → PASS, then `pnpm typecheck && pnpm lint`.

```bash
git add packages/cli/src/clones/clone-index.ts packages/cli/src/__tests__/clone-index*.test.ts
git commit -m "feat: add CloneIndex filesystem scanner"
```

---

### Task 3: `CloneRegistry` and `RunIndex.latestRunFor`

**Files:**
- Create: `packages/cli/src/clones/clone-registry.ts`
- Modify: `packages/cli/src/runs/run-index.ts`
- Test: `packages/cli/src/__tests__/clone-registry.test.ts`

- [ ] **Step 1: Extend `RunIndex` to carry `headSha`**

The resolution endpoint needs the stored `headSha` to detect a moved PR head. In `packages/cli/src/runs/run-index.ts`, change the per-PR map value from `string` to a small record. Full replacement of the affected parts:

```ts
export interface PrRun {
	runId: string;
	/** The commit the run was generated against — compared to the live head to detect staleness. */
	headSha: string;
}
```

- Add `headSha: chapterRun.headSha` to the constructor's `.select({...})`.
- Change `private readonly runIds = new Map<string, Map<number, string>>()` to `new Map<string, Map<number, PrRun>>()` and the insert line to `byPrNumber.set(run.prNumber, { runId: run.id, headSha: run.headSha });`.
- Add:

```ts
	/** Newest run for a PR with the head it was generated at, or null. */
	latestRunFor(nameWithOwner: string, prNumber: number): PrRun | null {
		return this.runIds.get(nameWithOwner.toLowerCase())?.get(prNumber) ?? null;
	}

	/** Newest run for a PR, or null if Stage has never generated chapters for it. */
	runIdFor(nameWithOwner: string, prNumber: number): string | null {
		return this.latestRunFor(nameWithOwner, prNumber)?.runId ?? null;
	}
```

Run: `pnpm typecheck` → PASS (existing callers only use `runIdFor`/`repoRootFor`).

- [ ] **Step 2: Write failing registry tests**

`packages/cli/src/__tests__/clone-registry.test.ts`. Uses a real temp DB; seeds the `RunIndex` fallback by inserting a `chapter_run` row directly. Look at `packages/cli/src/__tests__/fixtures.ts` for an existing `chapter_run` insert helper first and reuse it if one exists; otherwise insert inline:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCloneRoot } from "../clones/clone-root-store.js";
import { CloneRegistry } from "../clones/clone-registry.js";
import { closeDb, getDb, type StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { SCOPE_KIND } from "../schema.js";

let tmpDir = "";
let db: StageDb;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-clone-registry-"));
	closeDb();
	db = getDb({ dbPath: path.join(tmpDir, "db.sqlite") });
});
afterEach(async () => {
	closeDb();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeClone(rel: string, originUrl: string): Promise<string> {
	const dir = path.join(tmpDir, rel);
	await fs.mkdir(path.join(dir, ".git"), { recursive: true });
	await fs.writeFile(
		path.join(dir, ".git", "config"),
		`[remote "origin"]\n\turl = ${originUrl}\n`,
	);
	return dir;
}

function seedRun(repoRoot: string, originUrl: string): void {
	db.insert(chapterRun)
		.values({
			repoRoot,
			originUrl,
			scopeKind: SCOPE_KIND.COMMITTED,
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			mergeBaseSha: "a".repeat(40),
			generatedAt: new Date(),
		})
		.run();
}

describe("CloneRegistry.resolveRepoRoot", () => {
	it("resolves through the clone index", async () => {
		const dir = await makeClone("roots/api", "git@github.com:acme/api.git");
		addCloneRoot(db, path.join(tmpDir, "roots"));
		const registry = CloneRegistry.create(db);
		expect(registry.resolveRepoRoot("acme/api")).toBe(dir);
	});

	it("falls back to RunIndex when the index has no entry", async () => {
		const dir = await makeClone("elsewhere/api", "git@github.com:acme/api.git");
		seedRun(dir, "git@github.com:acme/api.git");
		const registry = CloneRegistry.create(db); // no roots configured
		expect(registry.resolveRepoRoot("acme/api")).toBe(dir);
	});

	it("reports no clone when an indexed path has since lost its .git", async () => {
		const dir = await makeClone("roots/api", "git@github.com:acme/api.git");
		addCloneRoot(db, path.join(tmpDir, "roots"));
		const registry = CloneRegistry.create(db);
		await fs.rm(path.join(dir, ".git"), { recursive: true });
		expect(registry.resolveRepoRoot("acme/api")).toBeNull();
	});

	it("falls through to a valid RunIndex path when the indexed path is stale", async () => {
		const indexed = await makeClone("roots/api", "git@github.com:acme/api.git");
		const historical = await makeClone("elsewhere/api", "git@github.com:acme/api.git");
		seedRun(historical, "git@github.com:acme/api.git");
		addCloneRoot(db, path.join(tmpDir, "roots"));
		const registry = CloneRegistry.create(db);
		await fs.rm(path.join(indexed, ".git"), { recursive: true });
		expect(registry.resolveRepoRoot("acme/api")).toBe(historical);
	});

	it("reports no clone when a RunIndex path has since been removed", async () => {
		const dir = await makeClone("gone/api", "git@github.com:acme/api.git");
		seedRun(dir, "git@github.com:acme/api.git");
		const registry = CloneRegistry.create(db);
		await fs.rm(dir, { recursive: true });
		expect(registry.resolveRepoRoot("acme/api")).toBeNull();
	});

	it("rescan picks up a newly added clone", async () => {
		addCloneRoot(db, tmpDir);
		const registry = CloneRegistry.create(db);
		expect(registry.resolveRepoRoot("acme/late")).toBeNull();
		await makeClone("late", "git@github.com:acme/late.git");
		const summary = registry.rescan();
		expect(summary.repoCount).toBeGreaterThanOrEqual(1);
		expect(registry.resolveRepoRoot("acme/late")).not.toBeNull();
	});
});
```

Run: FAIL (module missing).

- [ ] **Step 3: Implement `CloneRegistry`**

`packages/cli/src/clones/clone-registry.ts`. The scan is synchronous (`fs.*Sync` throughout `CloneIndex`), so concurrent rescans are impossible by construction — no in-flight promise bookkeeping needed. That satisfies the design's "serialized rescans" requirement by making a race unrepresentable.

```ts
import fs from "node:fs";
import path from "node:path";
import type { StageDb } from "../db/client.js";
import { RunIndex } from "../runs/run-index.js";
import { CloneIndex, type CloneOwner } from "./clone-index.js";
import { listCloneRoots } from "./clone-root-store.js";

export interface RescanSummary {
	repoCount: number;
	ownerCount: number;
}

/**
 * Owns the configured search roots and the current scan result. One instance
 * per server process, built at startup and injected into routes. The single
 * path-resolution entry point for both PR resolution and POST /api/generate.
 */
export class CloneRegistry {
	private index = CloneIndex.empty();

	private constructor(private readonly db: StageDb) {}

	static create(db: StageDb): CloneRegistry {
		const registry = new CloneRegistry(db);
		registry.rescan();
		return registry;
	}

	rescan(): RescanSummary {
		const roots = listCloneRoots(this.db).map((row) => row.path);
		this.index = CloneIndex.scan(roots);
		return { repoCount: this.index.size, ownerCount: this.index.owners().length };
	}

	owners(): CloneOwner[] {
		return this.index.owners();
	}

	isCloned(nameWithOwner: string): boolean {
		return this.resolveRepoRoot(nameWithOwner) !== null;
	}

	/**
	 * A usable local clone for the repo, or null. Tries the clone index, falls
	 * back to RunIndex — each candidate is validated independently (still holds
	 * a `.git` entry) before being returned, and a stale candidate from one
	 * source falls through to the next rather than suppressing it. Trusting an
	 * unvalidated path is how a moved clone becomes a raw ENOENT inside a
	 * spawned agent.
	 */
	resolveRepoRoot(nameWithOwner: string): string | null {
		const candidates = [
			this.index.pathFor(nameWithOwner),
			new RunIndex(this.db).repoRootFor(nameWithOwner),
		];
		for (const candidate of candidates) {
			if (candidate !== null && fs.existsSync(path.join(candidate, ".git"))) return candidate;
		}
		return null;
	}
}
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/cli/src/__tests__/clone-registry.test.ts` → PASS, then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/cli/src/clones/clone-registry.ts packages/cli/src/runs/run-index.ts packages/cli/src/__tests__/clone-registry.test.ts
git commit -m "feat: add CloneRegistry as the single repo-root resolver"
```

---

### Task 4: Wire types — `pull-requests`, `browse`, `clone-roots`, `queuePosition`

**Files:**
- Create: `packages/types/src/pull-requests.ts`, `packages/types/src/browse.ts`, `packages/types/src/clone-roots.ts`
- Modify: `packages/types/src/generation.ts`, `packages/types/src/index.ts`
- Delete: `packages/types/src/inbox.ts` (deferred to Task 6, when its last consumer goes)

No tests — pure Zod shape declarations (TESTING.md: trivial schema validation is a tautology). Type errors are the test.

- [ ] **Step 1: `packages/types/src/pull-requests.ts`**

```ts
import { z } from "zod";

export const PR_FILTER = {
	REVIEW_REQUESTED: "review-requested",
	ASSIGNEE: "assignee",
	AUTHOR: "author",
} as const;
export type PrFilter = (typeof PR_FILTER)[keyof typeof PR_FILTER];

export const DashboardPullRequestSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	repository: z.string(), // "owner/repo"
	author: z.string().nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
	/** runId when a run already exists for this PR, else null. */
	runId: z.string().nullable(),
	/** Whether a usable local clone of the repo is known. */
	cloned: z.boolean(),
});
export type DashboardPullRequest = z.infer<typeof DashboardPullRequestSchema>;

export const PullRequestListResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), pullRequests: z.array(DashboardPullRequestSchema) }),
]);
export type PullRequestListResponse = z.infer<typeof PullRequestListResponseSchema>;

export const PR_RESOLUTION = {
	READY: "ready",
	STALE: "stale",
	GENERATING: "generating",
	FAILED: "failed",
	NEEDS_GENERATION: "needs-generation",
	NO_CLONE: "no-clone",
} as const;
export type PrResolutionState = (typeof PR_RESOLUTION)[keyof typeof PR_RESOLUTION];

/**
 * What GET /api/pull-requests/:owner/:repo/:number returns. Always 200 when
 * the request is well-formed — the states are peers, not errors (see design
 * doc: a 422 here would reach jsonFetch as an opaque thrown error).
 */
export const PrResolutionSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal(PR_RESOLUTION.READY), runId: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.STALE), runId: z.string(), headSha: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.GENERATING), jobId: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.FAILED), jobId: z.string(), error: z.string() }),
	z.object({ state: z.literal(PR_RESOLUTION.NEEDS_GENERATION) }),
	z.object({ state: z.literal(PR_RESOLUTION.NO_CLONE), nameWithOwner: z.string() }),
]);
export type PrResolution = z.infer<typeof PrResolutionSchema>;
```

- [ ] **Step 2: `packages/types/src/browse.ts`**

```ts
import { z } from "zod";
import { DashboardPullRequestSchema } from "./pull-requests.ts";

export const CloneOwnerSchema = z.object({ owner: z.string(), cloneCount: z.number() });
export type CloneOwnerSummary = z.infer<typeof CloneOwnerSchema>;

export const OwnersResponseSchema = z.object({ owners: z.array(CloneOwnerSchema) });
export type OwnersResponse = z.infer<typeof OwnersResponseSchema>;

export const BrowseRepoSchema = z.object({
	nameWithOwner: z.string(),
	description: z.string().nullable(),
	updatedAt: z.string(),
	cloned: z.boolean(),
});
export type BrowseRepo = z.infer<typeof BrowseRepoSchema>;

export const OwnerReposResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), repos: z.array(BrowseRepoSchema) }),
]);
export type OwnerReposResponse = z.infer<typeof OwnerReposResponseSchema>;

export const RepoPullsResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), pullRequests: z.array(DashboardPullRequestSchema) }),
]);
export type RepoPullsResponse = z.infer<typeof RepoPullsResponseSchema>;
```

(Intra-package imports in `@stagereview/types` use `.ts` specifiers — match `index.ts`.)

- [ ] **Step 3: `packages/types/src/clone-roots.ts`**

```ts
import { z } from "zod";

export const CloneRootSchema = z.object({
	path: z.string(),
	addedAt: z.string(), // ISO — Drizzle Date serialized through JSON
});
export type CloneRoot = z.infer<typeof CloneRootSchema>;

export const CloneRootsResponseSchema = z.object({ roots: z.array(CloneRootSchema) });
export type CloneRootsResponse = z.infer<typeof CloneRootsResponseSchema>;

export const RescanResponseSchema = z.object({
	repoCount: z.number(),
	ownerCount: z.number(),
});
export type RescanResponse = z.infer<typeof RescanResponseSchema>;
```

- [ ] **Step 4: `queuePosition` on `GenerationJobSchema`**

In `packages/types/src/generation.ts`, add to `GenerationJobSchema` after `error`:

```ts
	/** 1-based place in line while queued; null when running or terminal. */
	queuePosition: z.number().nullable(),
```

This will break `packages/cli` compilation (JobManager, generate route, tests) — expected; Task 5 fixes it. Add the three new barrel exports to `packages/types/src/index.ts`:

```ts
export * from "./browse.ts";
export * from "./clone-roots.ts";
export * from "./pull-requests.ts";
```

- [ ] **Step 5: Commit (typecheck intentionally broken until Task 5 — commit both together if you prefer a green history)**

Preferred: hold this commit and land it with Task 5 as one commit. If committing separately anyway, do Task 5 immediately after.

---

### Task 5: `JobManager` — `queuePosition` and `latestJobFor`

**Files:**
- Modify: `packages/cli/src/generation/job-manager.ts`, `packages/cli/src/routes/generate.ts` (GET handler only)
- Test: `packages/cli/src/__tests__/job-manager.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

Extend `job-manager.test.ts` following its existing style (it injects a fake `JobRunner` — check the file first and reuse its helpers, e.g. a deferred runner that resolves on command). Behaviors to add:

```ts
it("reports 1-based queue position for queued jobs and null once running", async () => {
	// runner that blocks until released
	const first = manager.enqueue(request("https://github.com/o/r/pull/1"));
	const second = manager.enqueue(request("https://github.com/o/r/pull/2"));
	const third = manager.enqueue(request("https://github.com/o/r/pull/3"));
	expect(manager.get(first)?.queuePosition).toBeNull(); // running — drain() shifted it off the queue
	expect(manager.get(second)?.queuePosition).toBe(1);
	expect(manager.get(third)?.queuePosition).toBe(2);
	// release all, await settled()
	expect(manager.get(second)?.queuePosition).toBeNull(); // terminal
});

it("latestJobFor returns the most recent job for a PR regardless of status", async () => {
	// enqueue a job whose runner rejects; await settled()
	const failedId = /* ... */;
	expect(manager.activeJobFor(PR_URL)).toBeNull(); // terminal jobs stay invisible here
	expect(manager.latestJobFor(PR_URL)?.id).toBe(failedId);
	expect(manager.latestJobFor(PR_URL)?.status).toBe(JOB_STATUS.FAILED);
	expect(manager.latestJobFor("https://github.com/o/r/pull/999")).toBeNull();
});
```

Run: FAIL (`queuePosition` missing from snapshots, `latestJobFor` not a function). Note typecheck is failing anyway from Task 4 — that's fine, drive by the test.

- [ ] **Step 2: Implement**

In `job-manager.ts`:

1. In `enqueue`, add `queuePosition: null,` to the `Job` literal (satisfies the widened `GenerationJob`).
2. Add a private position helper and thread it through every snapshot:

```ts
	/** 1-based place in line, or null when running or terminal. drain() shifts the running job off the queue, so indexOf is exact. */
	private positionOf(job: Job): number | null {
		const idx = this.queue.indexOf(job);
		return idx >= 0 ? idx + 1 : null;
	}

	private snapshot(job: Job): Job {
		return { ...job, queuePosition: this.positionOf(job) };
	}
```

3. Change `get` to `return job ? this.snapshot(job) : null;`, and `activeJobFor`'s return to `return this.snapshot(job);`.
4. Add:

```ts
	/**
	 * The most recent job for this PR, any status — unlike activeJobFor, which
	 * skips terminal jobs. The resolver uses this to report `failed` instead of
	 * pretending generation was never attempted. Map preserves insertion order,
	 * so the last match is the newest.
	 */
	latestJobFor(prUrl: string): Job | null {
		const wanted = prUrl.toLowerCase();
		let latest: Job | null = null;
		for (const job of this.jobs.values()) {
			if (job.prUrl.toLowerCase() === wanted) latest = job;
		}
		return latest ? this.snapshot(latest) : null;
	}
```

5. In `routes/generate.ts`, the GET handler's destructure becomes:

```ts
				const { id, status, runId, error, queuePosition } = job;
				writeJson(res, 200, { id, status, runId, error, queuePosition } satisfies GenerationJob);
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm vitest run packages/cli/src/__tests__/job-manager.test.ts` → PASS. Then `pnpm typecheck` — if the web package still fails on `queuePosition` (it parses `GenerationJobSchema` but constructs no jobs), fix any literal `GenerationJob` objects in web tests by adding `queuePosition: null`. Then `pnpm lint && pnpm test`.

```bash
git add packages/types/src packages/cli/src/generation packages/cli/src/routes/generate.ts packages/cli/src/__tests__/job-manager.test.ts packages/web/src/lib/__tests__/use-inbox.test.tsx
git commit -m "feat: queue position and latestJobFor on generation jobs"
```

(Include the Task 4 type files in this commit.)

---

### Task 6: `pr-search.ts` — generalize the inbox search

**Files:**
- Create: `packages/cli/src/github/pr-search.ts`
- Delete: `packages/cli/src/github/inbox.ts`
- Modify: `packages/cli/src/__tests__/inbox.test.ts` → rename `pr-search.test.ts`
- Delete: `packages/types/src/inbox.ts` (and its `index.ts` barrel line) — after Task 9 removes the last web import; until then leave it

- [ ] **Step 1: Write/port failing tests**

Rename `packages/cli/src/__tests__/inbox.test.ts` to `pr-search.test.ts`. Keep the existing malformed-row-drop tests, updating imports and the mapper signature. Add filter-mapping coverage:

```ts
import { PR_FILTER } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { mapSearchResults, searchFlagFor } from "../github/pr-search.js";

describe("searchFlagFor", () => {
	it("maps each filter to its gh search flag", () => {
		expect(searchFlagFor(PR_FILTER.REVIEW_REQUESTED)).toBe("--review-requested=@me");
		expect(searchFlagFor(PR_FILTER.ASSIGNEE)).toBe("--assignee=@me");
		expect(searchFlagFor(PR_FILTER.AUTHOR)).toBe("--author=@me");
	});
});

describe("mapSearchResults", () => {
	// port existing tests; the deps arg gains isCloned
	it("marks rows cloned from the provided lookup", () => {
		const rows = mapSearchResults([validGhRow({ repository: { nameWithOwner: "o/r" } })], {
			runIdFor: () => null,
			isCloned: (repo) => repo === "o/r",
		});
		expect(rows[0]?.cloned).toBe(true);
	});
});
```

(`validGhRow` is whatever fixture helper the current `inbox.test.ts` uses — keep it.)

Run: FAIL.

- [ ] **Step 2: Implement `pr-search.ts`**

Move the contents of `github/inbox.ts` into `github/pr-search.ts`, then apply:

```ts
import type { DashboardPullRequest, PrFilter } from "@stagereview/types/pull-requests";
import { PR_FILTER } from "@stagereview/types/pull-requests";
import { z } from "zod";
import { gh } from "./exec.js";

// GhSearchPrSchema, SEARCH_FIELDS, SEARCH_LIMIT unchanged from inbox.ts

const SEARCH_FLAG: Record<PrFilter, string> = {
	[PR_FILTER.REVIEW_REQUESTED]: "--review-requested=@me",
	[PR_FILTER.ASSIGNEE]: "--assignee=@me",
	[PR_FILTER.AUTHOR]: "--author=@me",
};

export function searchFlagFor(filter: PrFilter): string {
	return SEARCH_FLAG[filter];
}

export interface SearchResultDeps {
	runIdFor: (repo: string, prNumber: number) => string | null;
	isCloned: (repo: string) => boolean;
}

/** Same drop-malformed-rows-with-a-logged-count contract as the old inbox mapper. */
export function mapSearchResults(raw: unknown[], deps: SearchResultDeps): DashboardPullRequest[] {
	// identical body to today's mapSearchResults, with the row gaining:
	//   runId: deps.runIdFor(pr.repository.nameWithOwner, pr.number),
	//   cloned: deps.isCloned(pr.repository.nameWithOwner),
	// and the warn prefix updated to `pull-requests:`.
}

/** Open PRs matching the filter across all orgs. Throws on gh failure. */
export async function searchPullRequests(filter: PrFilter, cwd: string): Promise<unknown[]> {
	const stdout = await gh(
		["search", "prs", searchFlagFor(filter), "--state=open", "--limit", String(SEARCH_LIMIT), "--json", SEARCH_FIELDS],
		cwd,
	);
	return z.array(z.unknown()).parse(JSON.parse(stdout));
}
```

Write the `mapSearchResults` body out in full (copy from `inbox.ts`, apply the two-line change). Delete `github/inbox.ts`. `routes/inbox.ts` now fails to compile — fix it in the same commit by updating it temporarily, or proceed straight to Task 7 which replaces that route; do Task 6 and 7 in one commit if simpler.

- [ ] **Step 3: Verify and commit** (with Task 7 if the route is replaced together)

---

### Task 7: Routes — `/api/pull-requests` list + resolution endpoint

**Files:**
- Create: `packages/cli/src/routes/pull-requests.ts`
- Delete: `packages/cli/src/routes/inbox.ts`
- Create: `packages/cli/src/github/live-head.ts`
- Test: `packages/cli/src/__tests__/pull-requests.routes.test.ts`

- [ ] **Step 1: The `liveHeadSha` seam**

`gh()` has no injection seam (per TESTING.md we don't add one to production code for tests' sake — but a route factory dependency is an existing pattern here: `JobManager` takes an injected runner). Give the route factory a `deps` parameter with a default real implementation. `packages/cli/src/github/live-head.ts`:

```ts
import { z } from "zod";
import { gh } from "./exec.js";

const HeadSchema = z.object({ headRefOid: z.string() });

/** Current head commit of a PR, via one `gh pr view --repo` call. Throws on gh failure. */
export async function liveHeadSha(nameWithOwner: string, prNumber: number): Promise<string> {
	const stdout = await gh(
		["pr", "view", String(prNumber), "--repo", nameWithOwner, "--json", "headRefOid"],
		process.cwd(),
	);
	return HeadSchema.parse(JSON.parse(stdout)).headRefOid;
}
```

- [ ] **Step 2: Write failing route tests**

`packages/cli/src/__tests__/pull-requests.routes.test.ts`, on the pattern of `runs-route-harness.ts` (temp DB + `startServer` + `getJson`) but starting the server with `pullRequestListRoutes(...)` and injected deps. The list endpoint shells out to `gh`, so test only the resolution endpoint at this layer (the list mapper is covered in Task 6; the `?filter=` validation gets one test via an invalid value, which never reaches `gh`).

Test each resolution state:

```ts
// Harness sketch — build per test:
//   const jobs = new JobManager(runner)  // controllable fake runner
//   const registry = CloneRegistry.create(db)
//   startServer({ webDistPath, routes: pullRequestListRoutes(db, jobs, registry, { liveHeadSha: fakeLiveHead }) })

it("returns ready when a run exists and the head matches", ...);      // seed chapter_run with headSha X; fakeLiveHead → X
it("returns stale with runId and headSha when the head moved", ...);  // fakeLiveHead → Y
it("returns ready when the live-head check fails (offline)", ...);    // fakeLiveHead throws
it("returns generating with the active jobId", ...);                  // enqueue a blocked job for the PR url
it("returns failed with the job error after a failed run", ...);      // runner rejects; await jobs.settled()
it("returns needs-generation when a clone is known and nothing else applies", ...); // clone fixture + clone root
it("returns no-clone with nameWithOwner otherwise", ...);
it("rejects an unknown filter on the list endpoint with 400", ...);
```

Seed helpers: reuse the `makeClone`/`seedRun` patterns from Task 3's test (extract shared helpers into `packages/cli/src/__tests__/fixtures.ts` if this repeats — DRY).

Run: FAIL.

- [ ] **Step 3: Implement the routes**

`packages/cli/src/routes/pull-requests.ts`:

```ts
import { JOB_STATUS } from "@stagereview/types/generation";
import type { PullRequestListResponse, PrResolution } from "@stagereview/types/pull-requests";
import { PR_FILTER, PR_RESOLUTION } from "@stagereview/types/pull-requests";
import { z } from "zod";
import type { CloneRegistry } from "../clones/clone-registry.js";
import type { StageDb } from "../db/client.js";
import type { JobManager } from "../generation/job-manager.js";
import { ghErrorMessage } from "../github/exec.js";
import { liveHeadSha as defaultLiveHeadSha } from "../github/live-head.js";
import { mapSearchResults, searchPullRequests } from "../github/pr-search.js";
import { toNameWithOwner, toPullRequestUrl } from "../github/index.js";
import { RunIndex } from "../runs/run-index.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";
import { parseNumber, query } from "./pull-request-shared.js";

export interface PullRequestRouteDeps {
	liveHeadSha: (nameWithOwner: string, prNumber: number) => Promise<string>;
}

const FilterSchema = z.enum(PR_FILTER);

export function pullRequestListRoutes(
	db: StageDb,
	jobs: JobManager,
	registry: CloneRegistry,
	deps: PullRequestRouteDeps = { liveHeadSha: defaultLiveHeadSha },
): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/pull-requests",
			handler: async (req, res) => {
				const parsed = FilterSchema.safeParse(query(req, "filter"));
				if (!parsed.success) {
					writeJson(res, 400, { error: "Unknown filter. Expected review-requested, assignee, or author." });
					return;
				}
				let raw: unknown[];
				try {
					raw = await searchPullRequests(parsed.data, process.cwd());
				} catch (err) {
					writeJson(res, 200, {
						available: false,
						reason: ghErrorMessage(err),
					} satisfies PullRequestListResponse);
					return;
				}
				const index = new RunIndex(db);
				writeJson(res, 200, {
					available: true,
					pullRequests: mapSearchResults(raw, {
						runIdFor: (repo, prNumber) => index.runIdFor(repo, prNumber),
						isCloned: (repo) => registry.isCloned(repo),
					}),
				} satisfies PullRequestListResponse);
			},
		},
		{
			method: "GET",
			pattern: "/api/pull-requests/:owner/:repo/:number",
			handler: async (_req, res, params) => {
				const number = parseNumber(params.number ?? null);
				const { owner, repo } = params;
				if (!owner || !repo || number === null) {
					writeJson(res, 400, { error: "Expected /api/pull-requests/:owner/:repo/:number" });
					return;
				}
				const location = { owner, repo, number };
				const nameWithOwner = toNameWithOwner(location);
				const prUrl = toPullRequestUrl(location);

				const active = jobs.activeJobFor(prUrl);
				if (active) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.GENERATING,
						jobId: active.id,
					} satisfies PrResolution);
					return;
				}

				const run = new RunIndex(db).latestRunFor(nameWithOwner, number);
				if (run) {
					let liveHead: string | null = null;
					try {
						liveHead = await deps.liveHeadSha(nameWithOwner, number);
					} catch {
						// Offline or gh missing — the stored run is still viewable, so
						// report ready rather than blocking the bookmark on a network call.
					}
					if (liveHead !== null && liveHead !== run.headSha) {
						writeJson(res, 200, {
							state: PR_RESOLUTION.STALE,
							runId: run.runId,
							headSha: run.headSha,
						} satisfies PrResolution);
						return;
					}
					writeJson(res, 200, {
						state: PR_RESOLUTION.READY,
						runId: run.runId,
					} satisfies PrResolution);
					return;
				}

				const latest = jobs.latestJobFor(prUrl);
				if (latest?.status === JOB_STATUS.FAILED) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.FAILED,
						jobId: latest.id,
						error: latest.error ?? "Generation failed",
					} satisfies PrResolution);
					return;
				}

				if (registry.resolveRepoRoot(nameWithOwner) === null) {
					writeJson(res, 200, {
						state: PR_RESOLUTION.NO_CLONE,
						nameWithOwner,
					} satisfies PrResolution);
					return;
				}
				writeJson(res, 200, { state: PR_RESOLUTION.NEEDS_GENERATION } satisfies PrResolution);
			},
		},
	];
}
```

State precedence (top to bottom): generating → ready/stale → failed → needs-generation/no-clone. A succeeded job's run is found through `RunIndex`, so a stale succeeded job never shadows a newer state.

Delete `routes/inbox.ts`. Don't wire into `core.ts` yet (Task 9 does the wiring in one pass).

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/cli/src/__tests__/pull-requests.routes.test.ts packages/cli/src/__tests__/pr-search.test.ts` → PASS. `pnpm typecheck` will fail on `core.ts` importing the deleted `inboxRoutes` — remove that import/spread line now (the dashboard temporarily loses the inbox until Task 9; acceptable mid-branch). Then `pnpm lint && pnpm test`.

```bash
git add -A packages/cli/src packages/types/src
git commit -m "feat: pull-request list and resolution endpoints"
```

---

### Task 8: Browse + clone-roots routes and gh wrappers

**Files:**
- Create: `packages/cli/src/github/repos.ts`, `packages/cli/src/github/pr-list.ts`
- Create: `packages/cli/src/routes/browse.ts`, `packages/cli/src/routes/clone-roots.ts`
- Test: `packages/cli/src/__tests__/browse-clone-roots.routes.test.ts`

- [ ] **Step 1: gh wrappers**

`packages/cli/src/github/repos.ts`:

```ts
import type { BrowseRepo } from "@stagereview/types/browse";
import { z } from "zod";
import { gh } from "./exec.js";

const GhRepoSchema = z.object({
	nameWithOwner: z.string(),
	description: z.string().nullable(),
	updatedAt: z.string(),
});

/**
 * Deliberate cap, not pagination: Browse shows the 200 most recently updated
 * repos under an owner. Owners with more repos see a truncated list; a PR in
 * an omitted repo is still reachable via its /pr/:owner/:repo/:number URL.
 */
const REPO_LIST_LIMIT = 200;

/** Repos under an owner the signed-in user can see, capped at REPO_LIST_LIMIT. Throws on gh failure. */
export async function listOrgRepos(
	owner: string,
	cwd: string,
	isCloned: (nameWithOwner: string) => boolean,
): Promise<BrowseRepo[]> {
	const stdout = await gh(
		["repo", "list", owner, "--limit", String(REPO_LIST_LIMIT), "--json", "nameWithOwner,description,updatedAt"],
		cwd,
	);
	const repos = z.array(GhRepoSchema).parse(JSON.parse(stdout));
	return repos.map((repo) => ({ ...repo, cloned: isCloned(repo.nameWithOwner) }));
}
```

`packages/cli/src/github/pr-list.ts`:

```ts
import type { DashboardPullRequest } from "@stagereview/types/pull-requests";
import { z } from "zod";
import { gh } from "./exec.js";

const GhPrSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	author: z.object({ login: z.string() }).nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
});

/**
 * Deliberate cap, not pagination: Browse shows the 50 most recent open PRs of
 * a repo. Anything beyond that is reachable via its /pr/:owner/:repo/:number
 * URL or the dashboard search sections.
 */
const PR_LIST_LIMIT = 50;

export interface RepoPullDeps {
	runIdFor: (repo: string, prNumber: number) => string | null;
	cloned: boolean;
}

/** Open PRs (drafts included — gh pr list's default) for one repo. Throws on gh failure. */
export async function listRepoPullRequests(
	nameWithOwner: string,
	cwd: string,
	deps: RepoPullDeps,
): Promise<DashboardPullRequest[]> {
	const stdout = await gh(
		["pr", "list", "--repo", nameWithOwner, "--state", "open", "--limit", String(PR_LIST_LIMIT), "--json", "number,title,url,author,isDraft,updatedAt"],
		cwd,
	);
	const prs = z.array(GhPrSchema).parse(JSON.parse(stdout));
	return prs.map((pr) => ({
		number: pr.number,
		title: pr.title,
		url: pr.url,
		repository: nameWithOwner,
		author: pr.author?.login ?? null,
		isDraft: pr.isDraft,
		updatedAt: pr.updatedAt,
		runId: deps.runIdFor(nameWithOwner, pr.number),
		cloned: deps.cloned,
	}));
}
```

- [ ] **Step 2: Write failing route tests**

`browse-clone-roots.routes.test.ts`, same harness pattern. `/api/owners` and all clone-roots routes never touch `gh`, so they test cleanly end-to-end. Skip route-level tests for `/api/owners/:owner/repos` and `/api/repos/:owner/:repo/pulls` (they'd need a `gh` stub; their mapping is a straight passthrough validated by Zod — the envelope/error path is identical code to the tested list route).

```ts
it("GET /api/owners returns owners with clone counts from the index", ...);   // two clone fixtures, one root
it("GET /api/clone-roots lists configured roots", ...);
it("POST /api/clone-roots adds a root and triggers a rescan", ...);           // add root, then /api/owners is non-empty
it("POST /api/clone-roots rejects a relative path with 400", ...);
it("POST /api/clone-roots enforces same-origin", ...);                        // evil Host header → 403, mirror generate.routes tests
it("DELETE /api/clone-roots removes a root and rescans", ...);
it("POST /api/clone-roots/rescan returns repo and owner counts", ...);
```

Run: FAIL.

- [ ] **Step 3: Implement the routes**

`packages/cli/src/routes/browse.ts`:

```ts
import type { OwnerReposResponse, OwnersResponse, RepoPullsResponse } from "@stagereview/types/browse";
import type { CloneRegistry } from "../clones/clone-registry.js";
import type { StageDb } from "../db/client.js";
import { ghErrorMessage } from "../github/exec.js";
import { listRepoPullRequests } from "../github/pr-list.js";
import { listOrgRepos } from "../github/repos.js";
import { RunIndex } from "../runs/run-index.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";

export function browseRoutes(db: StageDb, registry: CloneRegistry): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/owners",
			handler: (_req, res) => {
				writeJson(res, 200, { owners: registry.owners() } satisfies OwnersResponse);
			},
		},
		{
			method: "GET",
			pattern: "/api/owners/:owner/repos",
			handler: async (_req, res, params) => {
				const owner = params.owner;
				if (!owner) {
					writeJson(res, 400, { error: "Missing owner" });
					return;
				}
				try {
					const repos = await listOrgRepos(owner, process.cwd(), (name) => registry.isCloned(name));
					writeJson(res, 200, { available: true, repos } satisfies OwnerReposResponse);
				} catch (err) {
					writeJson(res, 200, { available: false, reason: ghErrorMessage(err) } satisfies OwnerReposResponse);
				}
			},
		},
		{
			method: "GET",
			pattern: "/api/repos/:owner/:repo/pulls",
			handler: async (_req, res, params) => {
				const { owner, repo } = params;
				if (!owner || !repo) {
					writeJson(res, 400, { error: "Missing owner or repo" });
					return;
				}
				const nameWithOwner = `${owner}/${repo}`.toLowerCase();
				const index = new RunIndex(db);
				try {
					const pullRequests = await listRepoPullRequests(nameWithOwner, process.cwd(), {
						runIdFor: (r, n) => index.runIdFor(r, n),
						cloned: registry.isCloned(nameWithOwner),
					});
					writeJson(res, 200, { available: true, pullRequests } satisfies RepoPullsResponse);
				} catch (err) {
					writeJson(res, 200, { available: false, reason: ghErrorMessage(err) } satisfies RepoPullsResponse);
				}
			},
		},
	];
}
```

`packages/cli/src/routes/clone-roots.ts`:

```ts
import type { CloneRootsResponse, RescanResponse } from "@stagereview/types/clone-roots";
import { z } from "zod";
import type { CloneRegistry } from "../clones/clone-registry.js";
import { addCloneRoot, listCloneRoots, removeCloneRoot } from "../clones/clone-root-store.js";
import type { StageDb } from "../db/client.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import { enforceSameOrigin } from "./pull-request-shared.js";

const RootInput = z.object({ path: z.string().min(1) });

export function cloneRootRoutes(db: StageDb, registry: CloneRegistry): Route[] {
	const respondWithRoots = (res: Parameters<Route["handler"]>[1]) => {
		writeJson(res, 200, {
			roots: listCloneRoots(db).map((r) => ({ path: r.path, addedAt: r.addedAt.toISOString() })),
		} satisfies CloneRootsResponse);
	};
	return [
		{
			method: "GET",
			pattern: "/api/clone-roots",
			handler: (_req, res) => respondWithRoots(res),
		},
		{
			method: "POST",
			pattern: "/api/clone-roots",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, RootInput);
				if (!body) return;
				try {
					addCloneRoot(db, body.path);
				} catch (err) {
					writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
					return;
				}
				registry.rescan(); // a just-added root should be usable without a second click
				respondWithRoots(res);
			},
		},
		{
			method: "DELETE",
			pattern: "/api/clone-roots",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, RootInput);
				if (!body) return;
				removeCloneRoot(db, body.path);
				registry.rescan();
				respondWithRoots(res);
			},
		},
		{
			method: "POST",
			pattern: "/api/clone-roots/rescan",
			handler: (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				writeJson(res, 200, registry.rescan() satisfies RescanResponse);
			},
		},
	];
}
```

(Check `parseJsonBody`'s exact signature in `routes/json.ts` before use; also confirm the server's route matcher supports `DELETE` — read `server.ts`'s method handling and, if the harness test needs it, `getJson` gets a sibling `requestJson(method, port, path, body)` helper.)

- [ ] **Step 4: Verify and commit**

Run tests → PASS; `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/cli/src/github/repos.ts packages/cli/src/github/pr-list.ts packages/cli/src/routes/browse.ts packages/cli/src/routes/clone-roots.ts packages/cli/src/__tests__/browse-clone-roots.routes.test.ts
git commit -m "feat: browse and clone-root routes"
```

---

### Task 9: Wire it together — registry through `core.ts`, generate 422, CLI `config`

**Files:**
- Modify: `packages/cli/src/routes/generate.ts`, `packages/cli/src/routes/core.ts`, `packages/cli/src/start.ts`, `packages/cli/src/show.ts`, `packages/cli/src/index.ts`
- Test: extend `packages/cli/src/__tests__/generate.routes.test.ts`

- [ ] **Step 1: Failing test — generate resolves through the registry**

In `generate.routes.test.ts` (read it first; adapt to its harness): a PR in a repo with a clone-index hit but **no** prior run must be accepted (202), and a repo with neither must 422. Today only the RunIndex path exists, so the first is the failing test.

- [ ] **Step 2: `generateRoutes` takes the registry**

In `routes/generate.ts`, change the signature and the resolution block:

```ts
export function generateRoutes(
	jobs: JobManager,
	registry: CloneRegistry,
	defaultModel: GenerationModel = GENERATION_MODEL.SONNET,
): Route[] {
```

and replace the `new RunIndex(db).repoRootFor(...)` block with:

```ts
				const nameWithOwner = toNameWithOwner(location);
				const repoRoot = registry.resolveRepoRoot(nameWithOwner);
				if (!repoRoot) {
					writeJson(res, 422, {
						error: `No local clone known for ${nameWithOwner}. Add a search root in Settings, or clone the repo first.`,
					});
					return;
				}
```

Drop the now-unused `db` parameter and `RunIndex` import.

- [ ] **Step 3: Wire `core.ts`, `start.ts`, `show.ts`**

`routes/core.ts` becomes:

```ts
export function coreRoutes(db: StageDb, defaultModel: GenerationModel): Route[] {
	const jobs = new JobManager(claudeRunner);
	const registry = CloneRegistry.create(db);
	return [
		...runRoutes(db),
		...viewStateRoutes(db),
		...commentRoutes(db),
		...viewerRoutes(),
		...diffRoutes(db),
		...pullRequestRoutes(db),
		...pullRequestMutationRoutes(db),
		...gitHubThreadRoutes(db),
		...pullRequestListRoutes(db, jobs, registry),
		...browseRoutes(db, registry),
		...cloneRootRoutes(db, registry),
		...generateRoutes(jobs, registry, defaultModel),
	];
}
```

(`CloneRegistry.create` is sync, so `coreRoutes` stays sync; `start.ts`/`show.ts` need no change beyond whatever the compiler demands.)

- [ ] **Step 4: CLI `config` subcommands**

In `packages/cli/src/index.ts`, add static imports at the top (`closeDb` is already imported; add `getDb` from `./db/client.js`, `addCloneRoot, listCloneRoots, removeCloneRoot` from `./clones/clone-root-store.js`, and `path` from `node:path`), then:

```ts
const config = program.command("config").description("Manage Stage configuration");

config
	.command("add-root")
	.description("Add a directory Stage scans for local git clones")
	.argument("<path>", "Path to a directory containing clones")
	.action((rootPath: string) => {
		addCloneRoot(getDb(), path.resolve(rootPath));
		closeDb();
		process.stdout.write(`Added ${path.resolve(rootPath)}\n`);
	});

config
	.command("remove-root")
	.description("Remove a clone search root")
	.argument("<path>", "The root path to remove")
	.action((rootPath: string) => {
		removeCloneRoot(getDb(), path.resolve(rootPath));
		closeDb();
		process.stdout.write(`Removed ${path.resolve(rootPath)}\n`);
	});

config
	.command("list-roots")
	.description("List clone search roots")
	.action(() => {
		const roots = listCloneRoots(getDb());
		closeDb();
		process.stdout.write(roots.length ? `${roots.map((r) => r.path).join("\n")}\n` : "No clone roots configured.\n");
	});
```

(`path.resolve` makes a relative CLI arg absolute against cwd — friendlier than rejecting it, and the store still enforces existence/directory-ness. Check how `import-command.test.ts` tests CLI actions and add a small test for `add-root` → `list-roots` round-trip if the pattern is cheap; otherwise the store tests cover the logic and this is wiring.)

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test` → all green. Manual smoke: `pnpm build && node packages/cli/dist/index.js config add-root ~/Documents && node packages/cli/dist/index.js start --no-open`, then `curl localhost:5391/api/owners` shows your owners.

```bash
git add packages/cli/src
git commit -m "feat: wire CloneRegistry through routes and add config subcommands"
```

---

### Task 10: Frontend — `use-pull-requests`, dedupe helper, dashboard sections

**Files:**
- Create: `packages/web/src/lib/use-pull-requests.ts`, `packages/web/src/lib/dedupe-pull-requests.ts`
- Test: `packages/web/src/lib/__tests__/dedupe-pull-requests.test.ts`
- Create: `packages/web/src/components/dashboard/pull-request-list.tsx`
- Modify: `packages/web/src/app/index.tsx`
- Delete: `packages/web/src/components/dashboard/inbox-list.tsx`
- Delete: `packages/types/src/inbox.ts` + its barrel export (last consumer gone after Task 11 removes `use-inbox.ts`; if `use-inbox` still exists at this point, defer deletion to Task 11)

- [ ] **Step 1: Failing dedupe test**

`packages/web/src/lib/__tests__/dedupe-pull-requests.test.ts` (pure, node env):

```ts
import type { DashboardPullRequest } from "@stagereview/types/pull-requests";
import { describe, expect, it } from "vitest";
import { dedupeAgainst } from "../dedupe-pull-requests";

function pr(url: string): DashboardPullRequest {
	return {
		number: 1, title: "t", url, repository: "o/r", author: null,
		isDraft: false, updatedAt: "2026-08-04T00:00:00Z", runId: null, cloned: true,
	};
}

describe("dedupeAgainst", () => {
	it("drops rows whose url appears in a resolved higher section", () => {
		expect(dedupeAgainst([pr("a"), pr("b")], [[pr("a")]])).toEqual([pr("b")]);
	});
	it("suppresses nothing for higher sections that have not resolved (null)", () => {
		expect(dedupeAgainst([pr("a")], [null])).toEqual([pr("a")]);
	});
	it("compares urls case-insensitively", () => {
		expect(dedupeAgainst([pr("https://github.com/O/R/pull/1")], [[pr("https://github.com/o/r/pull/1")]])).toEqual([]);
	});
});
```

- [ ] **Step 2: Implement helper and hook**

`packages/web/src/lib/dedupe-pull-requests.ts`:

```ts
import type { DashboardPullRequest } from "@stagereview/types/pull-requests";

/**
 * Top-down dedupe: a PR appearing in a higher dashboard section is dropped
 * from this one. A higher section that hasn't resolved (null — still loading
 * or errored) suppresses nothing; the later reflow is the accepted cost of
 * independent per-section failure domains (see design doc).
 */
export function dedupeAgainst(
	rows: DashboardPullRequest[],
	higherSections: (DashboardPullRequest[] | null)[],
): DashboardPullRequest[] {
	const seen = new Set<string>();
	for (const section of higherSections) {
		for (const row of section ?? []) seen.add(row.url.toLowerCase());
	}
	return rows.filter((row) => !seen.has(row.url.toLowerCase()));
}
```

`packages/web/src/lib/use-pull-requests.ts`:

```ts
import type { PrFilter, PullRequestListResponse } from "@stagereview/types/pull-requests";
import { PullRequestListResponseSchema } from "@stagereview/types/pull-requests";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

export const PULL_REQUESTS_QUERY_ROOT = "pull-requests";

/** `gh search prs` is slow and its results move slowly — a minute of staleness is fine. */
const STALE_TIME_MS = 60_000;

export function usePullRequests(filter: PrFilter) {
	return useQuery<PullRequestListResponse>({
		queryKey: [PULL_REQUESTS_QUERY_ROOT, filter],
		queryFn: async () =>
			PullRequestListResponseSchema.parse(
				await jsonFetch<unknown>(`/api/pull-requests?filter=${filter}`),
			),
		staleTime: STALE_TIME_MS,
	});
}
```

- [ ] **Step 3: `PullRequestList` component and dashboard**

`packages/web/src/components/dashboard/pull-request-list.tsx` — presentational; receives the query result and pre-deduped rows. Reuse `ListNotice`/`ListEmpty`, `Badge`, `Skeleton`, `formatTimeAgo` exactly as `inbox-list.tsx` did, minus all generation UI. A row is one `<Link>`:

```tsx
import type { DashboardPullRequest, PullRequestListResponse } from "@stagereview/types/pull-requests";
import { Link } from "@tanstack/react-router";
import { ListEmpty, ListNotice } from "@/components/dashboard/list-notice";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimeAgo } from "@/lib/format";

export interface PullRequestListProps {
	data: PullRequestListResponse | undefined;
	error: unknown;
	isLoading: boolean;
	/** Rows to render — already deduped against higher sections by the caller. */
	rows: DashboardPullRequest[];
	emptyText: string;
}

export function PullRequestList({ data, error, isLoading, rows, emptyText }: PullRequestListProps) {
	if (isLoading) {
		return (
			<div className="space-y-3">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-16 w-full" />
			</div>
		);
	}
	if (error || !data) {
		return (
			<ListNotice
				title="Couldn't load pull requests."
				details={error instanceof Error ? error.message : "The Stage server didn't respond."}
			/>
		);
	}
	if (!data.available) {
		return (
			<ListNotice
				title="Couldn't reach GitHub."
				details={
					<>
						<p>{data.reason}</p>
						<p>
							You may need to run <code>gh auth login</code>.
						</p>
					</>
				}
			/>
		);
	}
	if (rows.length === 0) {
		return <ListEmpty>{emptyText}</ListEmpty>;
	}
	return (
		<div className="divide-y divide-border overflow-hidden rounded-lg border">
			{rows.map((pr) => (
				<PullRequestRow key={pr.url} pullRequest={pr} />
			))}
		</div>
	);
}

function PullRequestRow({ pullRequest }: { pullRequest: DashboardPullRequest }) {
	const [owner = "", repo = ""] = pullRequest.repository.split("/");
	return (
		<Link
			to="/pr/$owner/$repo/$number"
			params={{ owner, repo, number: String(pullRequest.number) }}
			className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"
		>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">{pullRequest.title}</span>
					{pullRequest.isDraft && <Badge variant="outline">Draft</Badge>}
					{!pullRequest.cloned && <Badge variant="outline">Not cloned</Badge>}
				</div>
				<p className="mt-1 truncate text-muted-foreground text-xs">
					{pullRequest.repository} #{pullRequest.number} · {pullRequest.author ?? "unknown"} ·{" "}
					{formatTimeAgo(pullRequest.updatedAt)}
				</p>
			</div>
		</Link>
	);
}
```

`packages/web/src/app/index.tsx` — the three queries live here so dedupe can see across sections:

```tsx
import { PR_FILTER } from "@stagereview/types/pull-requests";
import { createFileRoute } from "@tanstack/react-router";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import { RunList } from "@/components/dashboard/run-list";
import { Topbar } from "@/components/layout/topbar";
import { SectionLabel } from "@/components/shared/section-label";
import { dedupeAgainst } from "@/lib/dedupe-pull-requests";
import { usePullRequests } from "@/lib/use-pull-requests";

export const Route = createFileRoute("/")({
	component: Dashboard,
});

function Dashboard() {
	const review = usePullRequests(PR_FILTER.REVIEW_REQUESTED);
	const assigned = usePullRequests(PR_FILTER.ASSIGNEE);
	const authored = usePullRequests(PR_FILTER.AUTHOR);

	const rowsOf = (q: typeof review) =>
		q.data?.available === true ? q.data.pullRequests : null;
	const reviewRows = rowsOf(review) ?? [];
	const assignedRows = dedupeAgainst(rowsOf(assigned) ?? [], [rowsOf(review)]);
	const authoredRows = dedupeAgainst(rowsOf(authored) ?? [], [rowsOf(review), rowsOf(assigned)]);

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-10 p-6 lg:p-8">
				<section className="space-y-3">
					<SectionLabel>Waiting on your review</SectionLabel>
					<PullRequestList {...review} rows={reviewRows} emptyText="Nothing is waiting on your review." />
				</section>
				<section className="space-y-3">
					<SectionLabel>Assigned to you</SectionLabel>
					<PullRequestList {...assigned} rows={assignedRows} emptyText="Nothing is assigned to you." />
				</section>
				<section className="space-y-3">
					<SectionLabel>Your open PRs</SectionLabel>
					<PullRequestList {...authored} rows={authoredRows} emptyText="You have no open pull requests." />
				</section>
				<section className="space-y-3">
					<SectionLabel>Recent runs</SectionLabel>
					<RunList />
				</section>
			</main>
		</>
	);
}
```

("Empty sections collapse to a single muted line" — `ListEmpty` already is that muted line; verify visually and tighten styling if it renders as a card.)

Delete `inbox-list.tsx`. If `use-inbox.ts` is now only consumed by its own test, delete both here along with `packages/types/src/inbox.ts` — its `useChapterGeneration` logic is re-homed in Task 11; copy it aside first if executing tasks strictly in order.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/web/src/lib/__tests__/dedupe-pull-requests.test.ts` → PASS; `pnpm typecheck && pnpm lint && pnpm test`; visual check via `pnpm dev:web` against a running `stagereview start`.

```bash
git add -A packages/web/src packages/types/src
git commit -m "feat: dashboard PR sections with top-down dedupe"
```

---

### Task 11: `use-pr-resolution` — the resolver state machine

**Files:**
- Create: `packages/web/src/lib/use-pr-resolution.ts`
- Test: `packages/web/src/lib/__tests__/use-pr-resolution.test.tsx`
- Delete: `packages/web/src/lib/use-inbox.ts`, `packages/web/src/lib/__tests__/use-inbox.test.tsx` (absorbed)

- [ ] **Step 1: Failing tests**

Model on `use-inbox.test.tsx` (happy-dom, `vi.stubGlobal("fetch", ...)` planned-response harness — one mocked boundary). The fetch plan gains a resolution response served for `GET /api/pull-requests/o/r/1`. Behaviors (split files if >200 lines):

```ts
it("auto-POSTs /api/generate exactly once on needs-generation, then polls the job", ...);
it("does not auto-POST when the resolution is failed", ...);   // fetch mock asserts no POST occurs
it("does not auto-POST when the resolution is stale", ...);
it("does not auto-POST from a cached needs-generation when the refetch reports failed", ...);
	// seed the query cache with needs-generation, serve `failed` from the mock;
	// assert no POST — the isFetchedAfterMount gate (remount/cache regression)
it("adopts the jobId from a generating resolution and polls it", ...);
it("exposes queuePosition from the polled job", ...);           // polled job with queuePosition: 2
it("retry() POSTs after a failure and transitions to polling", ...);
it("invalidates runs and pull-request caches when the job succeeds", ...);
```

- [ ] **Step 2: Implement**

`packages/web/src/lib/use-pr-resolution.ts`:

```ts
import {
	GenerateAcceptedSchema,
	type GenerationJob,
	GenerationJobSchema,
	isTerminalJobStatus,
	JOB_STATUS,
} from "@stagereview/types/generation";
import { PR_RESOLUTION, type PrResolution, PrResolutionSchema } from "@stagereview/types/pull-requests";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { PULL_REQUESTS_QUERY_ROOT } from "./use-pull-requests";
import { RUNS_QUERY_KEY } from "./use-runs";
import { jsonFetch } from "./use-view-state";

const JOB_POLL_INTERVAL_MS = 3_000;
const ErrorBodySchema = z.object({ error: z.string() });

export interface PrAddress {
	owner: string;
	repo: string;
	number: string;
}

async function startGeneration(prUrl: string): Promise<string> {
	const res = await fetch("/api/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prUrl }),
	});
	const raw: unknown = await res.json();
	if (!res.ok) {
		const parsed = ErrorBodySchema.safeParse(raw);
		throw new Error(parsed.success ? parsed.data.error : `POST /api/generate failed: ${res.status}`);
	}
	return GenerateAcceptedSchema.parse(raw).jobId;
}

export interface PrResolutionMachine {
	/** Server-reported resolution; undefined while loading. */
	resolution: PrResolution | undefined;
	resolutionError: unknown;
	/** Live job snapshot while generating (either auto-started or adopted). */
	job: GenerationJob | null;
	/** RunId to navigate to: from a ready resolution or a succeeded job. */
	runId: string | null;
	/** Explicit user action — Regenerate on stale, Retry on failed. */
	generate: () => void;
	generationError: string | null;
}

/**
 * The resolver state machine (see design doc "Resolver page"). The GET is
 * side-effect free; generating on view is client behavior, and only the
 * needs-generation state auto-POSTs — failed and stale wait for a click, so
 * a refresh never spends an agent session. Double-mount and multi-tab races
 * are safe because the server's activeJobFor dedupes on the canonical PR URL.
 *
 * The component calling this hook MUST be keyed by the normalized PR address
 * (see the resolver page). startedJobId and autoStarted are per-PR state; an
 * in-place route-param change (PR A → PR B) would otherwise leave B polling
 * A's job, suppress B's auto-generation, and let A's still-pending mutation
 * install its jobId after navigation. Remounting on key change resets all of
 * it and orphans the stale mutation callback.
 */
export function usePrResolution(address: PrAddress): PrResolutionMachine {
	const queryClient = useQueryClient();
	const prUrl = `https://github.com/${address.owner}/${address.repo}/pull/${address.number}`;
	const resolutionPath = `/api/pull-requests/${address.owner}/${address.repo}/${address.number}`;

	const resolutionQuery = useQuery<PrResolution>({
		queryKey: ["pr-resolution", address.owner.toLowerCase(), address.repo.toLowerCase(), address.number],
		queryFn: async () => PrResolutionSchema.parse(await jsonFetch<unknown>(resolutionPath)),
	});
	const resolution = resolutionQuery.data;

	const [startedJobId, setStartedJobId] = useState<string | null>(null);
	const { mutate, error: startError } = useMutation({
		mutationFn: () => startGeneration(prUrl),
		onSuccess: setStartedJobId,
	});

	const autoStarted = useRef(false);
	// Gate on isFetchedAfterMount: a cached needs-generation served synchronously
	// on remount may be stale (the last attempt may have failed or succeeded
	// since), and POSTing from it would spend a second agent session. Only a
	// resolution the server confirmed after this mount may auto-start.
	const needsGeneration =
		resolution?.state === PR_RESOLUTION.NEEDS_GENERATION && resolutionQuery.isFetchedAfterMount;
	useEffect(() => {
		if (!needsGeneration || autoStarted.current) return;
		autoStarted.current = true;
		mutate();
	}, [needsGeneration, mutate]);

	const jobId =
		startedJobId ?? (resolution?.state === PR_RESOLUTION.GENERATING ? resolution.jobId : null);

	const { data: job, error: pollError } = useQuery<GenerationJob>({
		queryKey: ["generation-job", jobId],
		queryFn:
			jobId === null
				? skipToken
				: async () =>
						GenerationJobSchema.parse(
							await jsonFetch<unknown>(`/api/generate/${encodeURIComponent(jobId)}`),
						),
		retry: false,
		refetchInterval: (query) => {
			if (query.state.status === "error") return false;
			const data = query.state.data;
			return data && isTerminalJobStatus(data.status) ? false : JOB_POLL_INTERVAL_MS;
		},
	});

	const succeeded = job?.status === JOB_STATUS.SUCCEEDED;
	useEffect(() => {
		if (!succeeded) return;
		void queryClient.invalidateQueries({ queryKey: RUNS_QUERY_KEY });
		void queryClient.invalidateQueries({ queryKey: [PULL_REQUESTS_QUERY_ROOT] });
	}, [succeeded, queryClient]);

	const resolvedRunId = resolution?.state === PR_RESOLUTION.READY ? resolution.runId : null;

	return {
		resolution,
		resolutionError: resolutionQuery.error,
		job: job ?? null,
		runId: job?.runId ?? resolvedRunId,
		generate: () => mutate(),
		generationError:
			(startError instanceof Error ? startError.message : null) ??
			(pollError instanceof Error ? pollError.message : null) ??
			job?.error ??
			null,
	};
}
```

Delete `use-inbox.ts` and its test file; if `packages/types/src/inbox.ts` survived Task 10, delete it and its barrel export now.

- [ ] **Step 3: Verify and commit**

Run: `pnpm vitest run packages/web/src/lib/__tests__/use-pr-resolution*.test.tsx` → PASS; `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add -A packages/web/src packages/types/src
git commit -m "feat: usePrResolution state machine, retiring use-inbox"
```

---

### Task 12: Resolver page `/pr/$owner/$repo/$number`

**Files:**
- Create: `packages/web/src/app/pr.$owner.$repo.$number.tsx`

Visual-only wiring over the tested hook — no new tests (TESTING.md). The route tree regenerates via the TanStack Router vite plugin on `pnpm dev:web`/`pnpm build`.

- [ ] **Step 1: Implement the page**

```tsx
import { JOB_STATUS } from "@stagereview/types/generation";
import { PR_RESOLUTION } from "@stagereview/types/pull-requests";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePrResolution } from "@/lib/use-pr-resolution";

export const Route = createFileRoute("/pr/$owner/$repo/$number")({
	component: PullRequestResolver,
});

function PullRequestResolver() {
	const params = Route.useParams();
	// Key by the normalized PR address: an in-place param change (PR A → PR B)
	// must remount ResolverForPr so usePrResolution's per-PR state resets — see
	// the hook's doc comment.
	const key = `${params.owner}/${params.repo}/${params.number}`.toLowerCase();
	return <ResolverForPr key={key} params={params} />;
}

function ResolverForPr({ params }: { params: { owner: string; repo: string; number: string } }) {
	const navigate = useNavigate();
	const machine = usePrResolution(params);
	const prLabel = `${params.owner}/${params.repo}#${params.number}`;

	// ready resolution or succeeded job → the run, replacing this transient page
	// in history so Back doesn't bounce through it.
	const { runId, resolution } = machine;
	const isStale = resolution?.state === PR_RESOLUTION.STALE;
	useEffect(() => {
		if (runId !== null && !isStale) {
			void navigate({ to: "/runs/$runId", params: { runId }, replace: true });
		}
	}, [runId, isStale, navigate]);

	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-2xl flex-1 space-y-4 p-6 lg:p-8">
				<ResolverBody machine={machine} prLabel={prLabel} params={params} />
			</main>
		</>
	);
}
```

`ResolverBody` renders one card per state (same file, below the route component):

- **loading** (`resolution === undefined`, no error): two `Skeleton` rows.
- **resolution fetch error**: reuse the `ListNotice`-style card with the error message.
- **`stale`**: card titled "This pull request has new commits since the review was written", with `<Button onClick={machine.generate}>Regenerate</Button>` and `<Button variant="secondary" asChild><Link to="/runs/$runId" params={{ runId: resolution.runId }}>Open the existing review</Link></Button>`. Once `machine.job` is non-null (Regenerate clicked), fall through to the progress card.
- **`needs-generation` / `generating` / a live `job`**: progress card naming `prLabel`; body is `Queued — {job.queuePosition} ahead` when `job?.status === JOB_STATUS.QUEUED && job.queuePosition !== null`, else `Chaptering…`, with a `Loader2` spinner. (Position N in queue = N−1 jobs ahead **plus** the running one — display `Queued — ${job.queuePosition} ahead` since the running job also precedes it; keep the copy from the design doc.)
- **`failed`** (or `machine.generationError` set with no live job): the error text in `text-destructive`, and `<Button onClick={machine.generate}><RefreshCw className="size-3.5" />Retry</Button>`. No auto-POST — refreshing this page costs nothing.
- **`no-clone`**: card "Stage needs a local clone of `{resolution.nameWithOwner}`", a `<code>` block with `git clone https://github.com/{resolution.nameWithOwner}.git` plus a copy button (`navigator.clipboard.writeText`, flip `Copy`→`Check` icon for 2s via `useState`), the configured roots (fetched with `useCloneRoots` from Task 13 — if executing in order, render without the roots list now and add it in Task 13), and a Rescan button that POSTs `/api/clone-roots/rescan` then invalidates the resolution query so a just-cloned repo resolves.

Write the full JSX for each card — follow the card idiom from `list-notice.tsx` (`rounded-lg border p-4` etc.) rather than inventing a new visual language.

- [ ] **Step 2: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`, then manual: `pnpm build`, `stagereview start`, click a dashboard row for an unchaptered cloned PR → progress card → lands on the run. Visit a PR in an uncloned repo → clone card.

```bash
git add packages/web/src/app packages/web/src/routeTree.gen.ts
git commit -m "feat: PR resolver page with per-state cards"
```

---

### Task 13: Browse pages, settings, onboarding, topbar

**Files:**
- Create: `packages/web/src/lib/use-browse.ts`, `packages/web/src/lib/use-clone-roots.ts`
- Create: `packages/web/src/app/browse.index.tsx`, `packages/web/src/app/browse.$owner.index.tsx`, `packages/web/src/app/browse.$owner.$repo.tsx`, `packages/web/src/app/settings.tsx`
- Create: `packages/web/src/components/dashboard/onboarding-card.tsx`
- Modify: `packages/web/src/components/layout/topbar.tsx`, `packages/web/src/app/index.tsx`

- [ ] **Step 1: Hooks**

`packages/web/src/lib/use-browse.ts`:

```ts
import {
	type OwnerReposResponse, OwnerReposResponseSchema,
	type OwnersResponse, OwnersResponseSchema,
	type RepoPullsResponse, RepoPullsResponseSchema,
} from "@stagereview/types/browse";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

const GH_STALE_TIME_MS = 60_000;

export function useOwners() {
	return useQuery<OwnersResponse>({
		queryKey: ["owners"],
		queryFn: async () => OwnersResponseSchema.parse(await jsonFetch<unknown>("/api/owners")),
	});
}

export function useOwnerRepos(owner: string) {
	return useQuery<OwnerReposResponse>({
		queryKey: ["owner-repos", owner.toLowerCase()],
		queryFn: async () =>
			OwnerReposResponseSchema.parse(
				await jsonFetch<unknown>(`/api/owners/${encodeURIComponent(owner)}/repos`),
			),
		staleTime: GH_STALE_TIME_MS,
	});
}

export function useRepoPulls(owner: string, repo: string) {
	return useQuery<RepoPullsResponse>({
		queryKey: ["repo-pulls", owner.toLowerCase(), repo.toLowerCase()],
		queryFn: async () =>
			RepoPullsResponseSchema.parse(
				await jsonFetch<unknown>(
					`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
				),
			),
		staleTime: GH_STALE_TIME_MS,
	});
}
```

`packages/web/src/lib/use-clone-roots.ts`:

```ts
import {
	type CloneRootsResponse, CloneRootsResponseSchema,
	type RescanResponse, RescanResponseSchema,
} from "@stagereview/types/clone-roots";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { jsonFetch } from "./use-view-state";

export const CLONE_ROOTS_QUERY_KEY = ["clone-roots"] as const;
const ErrorBodySchema = z.object({ error: z.string() });

export function useCloneRoots() {
	return useQuery<CloneRootsResponse>({
		queryKey: CLONE_ROOTS_QUERY_KEY,
		queryFn: async () => CloneRootsResponseSchema.parse(await jsonFetch<unknown>("/api/clone-roots")),
	});
}

async function mutateRoots(method: "POST" | "DELETE", path: string): Promise<CloneRootsResponse> {
	const res = await fetch("/api/clone-roots", {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
	const raw: unknown = await res.json();
	if (!res.ok) {
		const parsed = ErrorBodySchema.safeParse(raw);
		throw new Error(parsed.success ? parsed.data.error : `${method} /api/clone-roots failed: ${res.status}`);
	}
	return CloneRootsResponseSchema.parse(raw);
}

/** Root writes invalidate everything derived from the scan. */
function useRootsMutation(method: "POST" | "DELETE") {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (path: string) => mutateRoots(method, path),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: CLONE_ROOTS_QUERY_KEY });
			void queryClient.invalidateQueries({ queryKey: ["owners"] });
			void queryClient.invalidateQueries({ queryKey: ["pull-requests"] });
		},
	});
}

export function useAddCloneRoot() {
	return useRootsMutation("POST");
}

export function useRemoveCloneRoot() {
	return useRootsMutation("DELETE");
}

export function useRescan() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (): Promise<RescanResponse> => {
			const res = await fetch("/api/clone-roots/rescan", { method: "POST" });
			return RescanResponseSchema.parse(await res.json());
		},
		onSuccess: () => {
			void queryClient.invalidateQueries(); // scan results feed owners, lists, and resolutions alike
		},
	});
}
```

- [ ] **Step 2: Browse pages**

Three small pages, each `Topbar` + list, reusing `ListNotice`/`ListEmpty`/`Badge`/`Skeleton`:

- `browse.index.tsx` — `useOwners()`; each owner is a `<Link to="/browse/$owner">` row showing `owner` and `{cloneCount} clones`. When `owners.length === 0`, render the onboarding card (Step 4) in place of the list.
- `browse.$owner.index.tsx` — `useOwnerRepos(owner)`; rows link to `/browse/$owner/$repo` (split `nameWithOwner` on `/` for params) with a `Not cloned` outline badge when `!repo.cloned`, plus `description` and `formatTimeAgo(updatedAt)` in the muted line.
- `browse.$owner.$repo.tsx` — `useRepoPulls(owner, repo)`; render rows with the existing `PullRequestList` component (`rows={data.available ? data.pullRequests : []}`), passing a `Chaptered` badge — extend `PullRequestRow` in `pull-request-list.tsx` to show `<Badge variant="outline">Chaptered</Badge>` when `pullRequest.runId !== null` (this improves the dashboard too).

Write each page in full when implementing; they are the `browse.index.tsx` pattern with different hooks and row fields.

- [ ] **Step 3: Settings page**

`packages/web/src/app/settings.tsx` — permanent roots UI:

```tsx
// Structure (write in full):
// <Topbar />
// <SectionLabel>Clone roots</SectionLabel>
// - list of roots from useCloneRoots(), each with a remove Button (useRemoveCloneRoot)
// - an add form: <Input placeholder="/Users/you/code" /> + Add button (useAddCloneRoot),
//   showing mutation.error.message under the field on failure
// - a Rescan button (useRescan); after success show
//   `{data.repoCount} repos across {data.ownerCount} owners` in muted text
```

- [ ] **Step 4: Onboarding card + dashboard + topbar**

`packages/web/src/components/dashboard/onboarding-card.tsx`: a bordered card — title "Stage doesn't know where your clones live", one sentence ("Add a folder that contains your git clones so Stage can chapter PRs from it."), an inline `Input` + Add button driven by `useAddCloneRoot`, and a link to `/settings`.

In `app/index.tsx`, show it at the top only when both hold (design doc "Onboarding"): `useCloneRoots()` returns zero roots, **and** at least one row across the three resolved PR sections has `cloned === false`.

In `topbar.tsx`, add right-side links before the theme toggle:

```tsx
<nav className="flex items-center gap-4 text-muted-foreground text-sm">
	<Link to="/" className="transition-colors hover:text-foreground">Dashboard</Link>
	<Link to="/browse" className="transition-colors hover:text-foreground">Browse</Link>
	<Link to="/settings" className="transition-colors hover:text-foreground">Settings</Link>
</nav>
```

(Wrap the Stage mark in a `<Link to="/">` while there.) Also finish the Task 12 leftover: the no-clone card's "search roots it looked in" list via `useCloneRoots`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`. Manual sweep: `pnpm build && stagereview start` — zero-roots onboarding appears; add a root in settings; rescan reports counts; `/browse` lists owners; owner → repos with badges; repo → PRs; uncloned PR → clone card → clone it → Rescan → generates.

```bash
git add -A packages/web/src
git commit -m "feat: browse pages, settings, and clone-root onboarding"
```

---

### Task 14: Final sweep

- [ ] **Step 1: Dead-code check** — confirm `github/inbox.ts`, `routes/inbox.ts`, `types/src/inbox.ts`, `use-inbox.ts`, `inbox-list.tsx` are all deleted and nothing references `INBOX_QUERY_KEY` or `/api/inbox` (`git grep -i inbox` should hit only docs/history).
- [ ] **Step 2: Design-doc conformance read** — reread the design doc's Decisions table against the implementation; fix drift.
- [ ] **Step 3: Full gate** — `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all green.
- [ ] **Step 4: Update docs** — if `AGENTS.md`'s architecture tree is materially wrong now (new `clones/` dir), add the one line.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove dead inbox code and align docs"
```

---

## Self-review notes (already applied)

- **Spec coverage:** every design-doc row maps to a task — clone store/index/registry (1–3), pr-search + gh wrappers (6, 8), routes incl. 422 and queuePosition (7–9), CLI config (9), frontend routes/hooks/pages (10–13), onboarding (13). Out-of-scope items from the design doc are not planned.
- **Known judgment calls encoded above:** sync `CloneIndex.scan` makes rescan-serialization structural; live-head check failure degrades to `ready` (a bookmark must not break offline); `POST /api/clone-roots` rescans inline so onboarding works in one click.
- **Type consistency:** `DashboardPullRequest.cloned`, `PrResolution` payloads, `queuePosition: number | null`, and `RescanSummary`/`RescanResponse` names are used consistently across tasks; `latestRunFor` returns `PrRun {runId, headSha}` everywhere it's referenced.
