# Stage Start Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `stagereview start` daemon mode with a home dashboard: past runs across all repos, a cross-org "PRs waiting on you" inbox via `gh search prs`, and one-click chapter generation that shells out to headless `claude -p` (Sonnet by default).

**Architecture:** The global SQLite DB already holds runs from every repo, so the dashboard is a new list endpoint plus a new home page replacing the current "No run selected" dead-end. The inbox follows the existing live-fetch-never-store GitHub pattern (`gh` shelled out, degrade to unavailable on failure). Generation needs a new non-blocking `stagereview import` subcommand, because `show` opens a browser and blocks on Ctrl+C — the headless agent uses `import`, and the daemon's UI links to the run when it appears.

**Tech Stack:** Commander, Node `http` (existing `server.ts`), Drizzle + better-sqlite3, `gh` CLI, `claude` CLI (headless `-p`), React 19 + TanStack Router/Query, Vitest.

**Decisions locked in this session:**
- Primary use case is reviewing other people's remote PRs (`--pr`), not local branches.
- Generation model: Sonnet default (`--model sonnet`), configurable — never Haiku by default (key-change quality + hunk-coverage validation).
- Batch/one-click generation must show usage cost up front ("this runs N agent sessions") and run sequentially.
- Headless `claude -p` on a subscription seat is permitted and draws from the same usage windows.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/types/src/run-summary.ts` | Create | Wire type + Zod schema for the runs list |
| `packages/types/src/inbox.ts` | Create | Wire type + Zod schema for the PR inbox |
| `packages/types/src/index.ts` | Modify | Barrel re-export |
| `packages/cli/src/routes/runs.ts` | Modify | Add `GET /api/runs` |
| `packages/cli/src/github/inbox.ts` | Create | `gh search prs` wrapper |
| `packages/cli/src/routes/inbox.ts` | Create | `GET /api/inbox` |
| `packages/cli/src/routes/generate.ts` | Create | `POST /api/generate`, `GET /api/generate/:jobId` |
| `packages/cli/src/generation/job-manager.ts` | Create | Spawn + track `claude -p` jobs (in-memory) |
| `packages/cli/src/import.ts` | Create | `stagereview import` implementation (insert run, print runId, exit) |
| `packages/cli/src/start.ts` | Create | `stagereview start` implementation (daemon) |
| `packages/cli/src/index.ts` | Modify | Register `start` and `import` subcommands |
| `packages/cli/src/show.ts` | Modify | Extract `buildChaptersFile` for reuse by `import.ts` |
| `packages/web/src/app/index.tsx` | Modify | Replace dead-end with dashboard |
| `packages/web/src/lib/use-runs.ts` | Create | Runs list query hook |
| `packages/web/src/lib/use-inbox.ts` | Create | Inbox query hook + generate mutation |
| `packages/web/src/components/dashboard/run-list.tsx` | Create | Past runs list |
| `packages/web/src/components/dashboard/inbox-list.tsx` | Create | PR inbox with generate button |

Tests live in `packages/cli/src/__tests__/` (Vitest, run with `pnpm test`) and `packages/web/src/lib/__tests__/`.

---

### Task 1: `RunSummary` wire type

**Files:**
- Create: `packages/types/src/run-summary.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Create the type module**

```ts
// packages/types/src/run-summary.ts
import { z } from "zod";

export const RunSummarySchema = z.object({
	id: z.string(),
	repoName: z.string(),
	prNumber: z.number().nullable(),
	scopeKind: z.string(),
	generatedAt: z.string(),
	chapterCount: z.number(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunListResponseSchema = z.object({
	runs: z.array(RunSummarySchema),
});
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
```

- [ ] **Step 2: Re-export from the barrel**

Add to `packages/types/src/index.ts`:

```ts
export * from "./run-summary.js";
```

(Match the existing export style in that file — check whether siblings use `.js` suffixes and subpath exports in `packages/types/package.json`; `chapters.ts` and `view-state.ts` are the precedents. If the package uses subpath exports like `@stagereview/types/pull-request`, add a `./run-summary` entry the same way.)

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm typecheck` — Expected: PASS

```bash
git add packages/types/src/run-summary.ts packages/types/src/index.ts packages/types/package.json
git commit -m "feat(types): add RunSummary wire type for the dashboard runs list"
```

### Task 2: `GET /api/runs` endpoint

**Files:**
- Modify: `packages/cli/src/routes/runs.ts`
- Test: `packages/cli/src/__tests__/runs-list-route.test.ts`

- [ ] **Step 1: Write the failing test**

Follow the existing route-test pattern in `packages/cli/src/__tests__/` (look at how existing tests construct an in-memory DB and call route handlers — mirror the nearest existing runs/comments route test exactly; they already have helpers for a temp SQLite DB and fake `req`/`res`). The behavioral assertions:

```ts
// packages/cli/src/__tests__/runs-list-route.test.ts
import { describe, expect, it } from "vitest";
// reuse the existing test DB + response-capture helpers from sibling tests

describe("GET /api/runs", () => {
	it("returns runs newest-first with chapter counts", async () => {
		// insert two runs via insertChaptersFile (same fixture builder sibling tests use),
		// the second with 3 chapters and prNumber 42
		// invoke the /api/runs handler
		// expect: status 200, body.runs.length === 2,
		//   body.runs[0] is the newer run,
		//   body.runs[0].chapterCount === 3,
		//   body.runs[0].prNumber === 42,
		//   each run has id/repoName/scopeKind/generatedAt strings
	});

	it("returns an empty list on a fresh DB", async () => {
		// invoke handler against empty DB; expect 200 and { runs: [] }
	});
});
```

(Write the real bodies by copying the setup from the nearest sibling test — the fixtures already exist; do not invent a new harness.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test -- runs-list-route` — Expected: FAIL (route not found / handler missing)

- [ ] **Step 3: Implement the route**

Add to `runRoutes()` in `packages/cli/src/routes/runs.ts` (this is an aggregation — count per run — so the SQL-like builder is the right Drizzle API here, consistent with the file's existing style):

```ts
import type { RunListResponse, RunSummary } from "@stagereview/types/run-summary";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
```

```ts
{
	method: "GET",
	pattern: "/api/runs",
	handler: (_req, res) => {
		const runs = db
			.select()
			.from(chapterRun)
			.orderBy(desc(chapterRun.generatedAt))
			.limit(200)
			.all();

		const counts = db
			.select({ runId: chapter.runId, chapterCount: count() })
			.from(chapter)
			.groupBy(chapter.runId)
			.all();
		const countByRun = new Map(counts.map((c) => [c.runId, c.chapterCount]));

		const body: RunListResponse = {
			runs: runs.map(
				(run): RunSummary => ({
					id: run.id,
					repoName: parseRepoName(run.originUrl, run.repoRoot),
					prNumber: run.prNumber,
					scopeKind: run.scopeKind,
					generatedAt: run.generatedAt.toISOString(),
					chapterCount: countByRun.get(run.id) ?? 0,
				}),
			),
		};
		writeJson(res, 200, body);
	},
},
```

Note: `?? 0` here is a boundary-legitimate default — a run genuinely can have zero chapter rows only if import failed mid-transaction, which the transaction prevents; but `Map.get` types as `T | undefined` under `noUncheckedIndexedAccess` and a run with no chapters is representable, so 0 is the correct value, not a lie.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm test -- runs-list-route && pnpm typecheck && pnpm lint` — Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/routes/runs.ts packages/cli/src/__tests__/runs-list-route.test.ts
git commit -m "feat(cli): add GET /api/runs listing all runs newest-first"
```

### Task 3: Extract `buildChaptersFile` and add `stagereview import`

**Files:**
- Modify: `packages/cli/src/show.ts` (extract `buildChaptersFile`, `assembleChaptersFile`, `validateHunkCoverage`, `sanitizeLineRefs` into a new module)
- Create: `packages/cli/src/build-chapters-file.ts`
- Create: `packages/cli/src/import.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/__tests__/import-command.test.ts`

- [ ] **Step 1: Move, don't rewrite**

Cut `buildChaptersFile`, `BuiltChaptersFile`, `assembleChaptersFile`, `validateHunkCoverage`, `sanitizeLineRefs`, and the `HunkSpan` interface out of `packages/cli/src/show.ts` into `packages/cli/src/build-chapters-file.ts`, exporting `buildChaptersFile` and `BuiltChaptersFile`. Update `show.ts` to import them. No behavior change.

Run: `pnpm test && pnpm typecheck` — Expected: PASS (pure move)

```bash
git add packages/cli/src/show.ts packages/cli/src/build-chapters-file.ts
git commit -m "refactor(cli): extract buildChaptersFile from show for reuse"
```

- [ ] **Step 2: Write the failing test for `import`**

```ts
// packages/cli/src/__tests__/import-command.test.ts
// Assert: runImport(jsonPath, options) inserts a run (query chapterRun count
// before/after) and returns the runId; it does NOT start a server or open a
// browser (it returns synchronously after insert). Reuse the chapters-file
// fixture from the show/import-chapters sibling tests.
```

Run: `pnpm test -- import-command` — Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/import.ts
import { buildChaptersFile } from "./build-chapters-file.js";
import { closeDb, getDb } from "./db/client.js";
import { readRepoContext } from "./git.js";
import { insertChaptersFile } from "./runs/import-chapters.js";
import type { DiffScopeOptions } from "./scope.js";

/**
 * Insert a chapters file into the DB without serving it. Prints the runId so
 * headless generation (the dashboard's `claude -p` jobs) can hand the run back
 * to an already-running `stagereview start` server.
 */
export async function runImport(jsonPath: string, options: DiffScopeOptions): Promise<string> {
	const db = getDb();
	const { chaptersFile, prNumber } = await buildChaptersFile(jsonPath, options);
	const { runId } = insertChaptersFile(db, chaptersFile, readRepoContext(), prNumber);
	closeDb();
	return runId;
}
```

Register in `packages/cli/src/index.ts`, mirroring the `show` command exactly (same arguments and options, since `import` recomputes scope the same way):

```ts
program
	.command("import")
	.description("Load a chapters.json file into the local database without opening a browser")
	.argument("<path>", "Path to a chapters.json file")
	.argument("[refs...]", "Git refs to diff, for example: main, main feature, or main..feature")
	.option("--base <ref>", "Base ref to diff against (default: auto-detect main/master)")
	.option("--compare <ref>", "Compare ref to diff against --base")
	.option("--pr <ref>", "Review a GitHub pull request by number or URL")
	.addOption(refOption)
	.action(async (jsonPath: string, refs: string[], opts: DiffCommandOptions) => {
		const runId = await runImport(jsonPath, toDiffScopeOptions(refs, opts));
		process.stdout.write(`${runId}\n`);
	});
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test -- import-command && pnpm typecheck && pnpm lint` — Expected: PASS

```bash
git add packages/cli/src/import.ts packages/cli/src/index.ts packages/cli/src/__tests__/import-command.test.ts
git commit -m "feat(cli): add stagereview import for headless run insertion"
```

### Task 4: `stagereview start` daemon command

**Files:**
- Create: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Implement `start`**

`start` reuses everything `show` wires up, minus the run insertion and with the browser landing on `/`:

```ts
// packages/cli/src/start.ts
import open from "open";
import { closeDb, getDb } from "./db/client.js";
import { commentRoutes } from "./routes/comments.js";
import { diffRoutes } from "./routes/diff.js";
import { generateRoutes } from "./routes/generate.js"; // Task 6 — omit until then
import { gitHubThreadRoutes } from "./routes/github-threads.js";
import { inboxRoutes } from "./routes/inbox.js"; // Task 5 — omit until then
import { pullRequestRoutes } from "./routes/pull-request.js";
import { pullRequestMutationRoutes } from "./routes/pull-request-mutations.js";
import { runRoutes } from "./routes/runs.js";
import { viewStateRoutes } from "./routes/view-state.js";
import { viewerRoutes } from "./routes/viewer.js";
import { LOOPBACK_HOST, startServer } from "./server.js";

export interface StartOptions {
	open: boolean;
}

export async function start(options: StartOptions): Promise<void> {
	const db = getDb();
	const handle = await startServer({
		routes: [
			...runRoutes(db),
			...viewStateRoutes(db),
			...commentRoutes(db),
			...viewerRoutes(),
			...diffRoutes(db),
			...pullRequestRoutes(db),
			...pullRequestMutationRoutes(db),
			...gitHubThreadRoutes(db),
		],
	});
	const url = `http://${LOOPBACK_HOST}:${handle.port}/`;
	process.stdout.write(`Stage dashboard on ${url}\n`);
	process.stdout.write("Press Ctrl+C to exit.\n");
	if (options.open) {
		try {
			await open(url);
		} catch {
			// URL is on stdout — user can navigate manually.
		}
	}
	await waitForShutdownSignal();
	await handle.close();
	closeDb();
}
```

Move `waitForShutdownSignal` from `show.ts` into a shared location (simplest: export it from `server.ts`) and import it in both `show.ts` and `start.ts` — don't duplicate it.

Register the command in `index.ts`:

```ts
program
	.command("start")
	.description("Start the Stage dashboard: browse past runs and PRs awaiting your review")
	.option("--no-open", "Do not open a browser")
	.action(async (opts: { open: boolean }) => {
		await start({ open: opts.open });
	});
```

- [ ] **Step 2: Manual verification**

Run: `pnpm build && node packages/cli/dist/index.js start --no-open`, then `curl -s http://127.0.0.1:5391/api/runs` — Expected: `{"runs":[...]}` JSON; Ctrl+C exits cleanly.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/start.ts packages/cli/src/index.ts packages/cli/src/show.ts packages/cli/src/server.ts
git commit -m "feat(cli): add stagereview start daemon serving the dashboard"
```

### Task 5: PR inbox (`gh search prs`)

**Files:**
- Create: `packages/types/src/inbox.ts`
- Create: `packages/cli/src/github/inbox.ts`
- Create: `packages/cli/src/routes/inbox.ts`
- Modify: `packages/cli/src/start.ts` (register `inboxRoutes`)
- Test: `packages/cli/src/__tests__/inbox.test.ts`

- [ ] **Step 1: Wire type**

```ts
// packages/types/src/inbox.ts
import { z } from "zod";

export const InboxPullRequestSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	repository: z.string(), // "owner/repo"
	author: z.string(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
	/** runId when a run already exists for this PR in this repo, else null. */
	runId: z.string().nullable(),
});
export type InboxPullRequest = z.infer<typeof InboxPullRequestSchema>;

export const InboxResponseSchema = z.union([
	z.object({ available: z.literal(false), reason: z.string() }),
	z.object({ available: z.literal(true), pullRequests: z.array(InboxPullRequestSchema) }),
]);
export type InboxResponse = z.infer<typeof InboxResponseSchema>;
```

Export from the barrel/subpath exactly as in Task 1.

- [ ] **Step 2: Failing test for the search mapper**

Test the pure mapping (gh output → wire shape) — do not shell out in tests:

```ts
// packages/cli/src/__tests__/inbox.test.ts
import { describe, expect, it } from "vitest";
import { mapSearchResults } from "../github/inbox.js";

const GH_FIXTURE = [
	{
		number: 7,
		title: "Add stack navigator",
		url: "https://github.com/acme/widgets/pull/7",
		repository: { nameWithOwner: "acme/widgets" },
		author: { login: "sam" },
		isDraft: false,
		updatedAt: "2026-07-30T12:00:00Z",
	},
];

describe("mapSearchResults", () => {
	it("maps gh search output and attaches an existing runId", () => {
		const runIdLookup = (repo: string, prNumber: number) =>
			repo === "acme/widgets" && prNumber === 7 ? "run-123" : null;
		const result = mapSearchResults(GH_FIXTURE, runIdLookup);
		expect(result).toEqual([
			{
				number: 7,
				title: "Add stack navigator",
				url: "https://github.com/acme/widgets/pull/7",
				repository: "acme/widgets",
				author: "sam",
				isDraft: false,
				updatedAt: "2026-07-30T12:00:00Z",
				runId: "run-123",
			},
		]);
	});
});
```

Run: `pnpm test -- inbox` — Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/github/inbox.ts
import type { InboxPullRequest } from "@stagereview/types/inbox";
import { z } from "zod";
import { gh } from "./exec.js";

const GhSearchPrSchema = z.object({
	number: z.number(),
	title: z.string(),
	url: z.string(),
	repository: z.object({ nameWithOwner: z.string() }),
	author: z.object({ login: z.string() }).nullable(),
	isDraft: z.boolean(),
	updatedAt: z.string(),
});
export type GhSearchPr = z.infer<typeof GhSearchPrSchema>;

const SEARCH_FIELDS = "number,title,url,repository,author,isDraft,updatedAt";

export function mapSearchResults(
	raw: unknown[],
	runIdFor: (repo: string, prNumber: number) => string | null,
): InboxPullRequest[] {
	return raw.flatMap((item) => {
		const parsed = GhSearchPrSchema.safeParse(item);
		if (!parsed.success) return [];
		const pr = parsed.data;
		return [
			{
				number: pr.number,
				title: pr.title,
				url: pr.url,
				repository: pr.repository.nameWithOwner,
				author: pr.author?.login ?? "",
				isDraft: pr.isDraft,
				updatedAt: pr.updatedAt,
				runId: runIdFor(pr.repository.nameWithOwner, pr.number),
			},
		];
	});
}

/** PRs across all orgs awaiting the signed-in user's review. Throws on gh failure. */
export async function searchReviewRequested(cwd: string): Promise<unknown[]> {
	const stdout = await gh(
		["search", "prs", "--review-requested=@me", "--state=open", "--limit=50", "--json", SEARCH_FIELDS],
		cwd,
	);
	return z.array(z.unknown()).parse(JSON.parse(stdout));
}
```

```ts
// packages/cli/src/routes/inbox.ts
import type { InboxResponse } from "@stagereview/types/inbox";
import { desc } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { ghErrorMessage } from "../github/exec.js";
import { mapSearchResults, searchReviewRequested } from "../github/inbox.js";
import { parseGitHubRepo } from "../github/repo.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";

export function inboxRoutes(db: StageDb): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/inbox",
			handler: async (_req, res) => {
				let raw: unknown[];
				try {
					raw = await searchReviewRequested(process.cwd());
				} catch (err) {
					const body: InboxResponse = { available: false, reason: ghErrorMessage(err) };
					writeJson(res, 200, body);
					return;
				}
				// Newest run per (owner/repo, prNumber) so inbox rows deep-link to a run.
				const runs = db
					.select()
					.from(chapterRun)
					.orderBy(desc(chapterRun.generatedAt))
					.all();
				const runIdByRepoPr = new Map<string, Map<number, string>>();
				for (const run of runs) {
					const repo = parseGitHubRepo(run.originUrl);
					if (!repo || run.prNumber === null) continue;
					const key = `${repo.owner}/${repo.repo}`;
					let byPr = runIdByRepoPr.get(key);
					if (!byPr) {
						byPr = new Map();
						runIdByRepoPr.set(key, byPr);
					}
					if (!byPr.has(run.prNumber)) byPr.set(run.prNumber, run.id);
				}
				const pullRequests = mapSearchResults(
					raw,
					(repo, prNumber) => runIdByRepoPr.get(repo)?.get(prNumber) ?? null,
				);
				const body: InboxResponse = { available: true, pullRequests };
				writeJson(res, 200, body);
			},
		},
	];
}
```

(The `key` above is a display identity GitHub itself defines as `owner/repo` — it comes straight from `nameWithOwner`, not an invented composite; the nested `Map<number, string>` keeps PR-number lookup structural per the no-stringly-typed-keys rule.)

Register `...inboxRoutes(db)` in `start.ts`.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test -- inbox && pnpm typecheck && pnpm lint` — Expected: PASS

```bash
git add packages/types/src/inbox.ts packages/cli/src/github/inbox.ts packages/cli/src/routes/inbox.ts packages/cli/src/start.ts packages/types/src/index.ts
git commit -m "feat(cli): add cross-org PR inbox via gh search prs"
```

### Task 6: Generation jobs (`claude -p`)

**Files:**
- Create: `packages/cli/src/generation/job-manager.ts`
- Create: `packages/cli/src/routes/generate.ts`
- Modify: `packages/cli/src/start.ts` (register routes)
- Test: `packages/cli/src/__tests__/job-manager.test.ts`

**Design constraints (from session):**
- Mutating endpoint → must use `enforceSameOrigin` from `routes/pull-request-shared.ts`, like every other mutation.
- The spawned agent must end with `stagereview import --pr <url>` (Task 3), NOT `show`.
- Repo mapping: only generate for repos stage already knows — look up `repoRoot` from past runs with a matching `originUrl`. Unknown repo → 422 telling the user to run stage-chapters manually once from a clone. YAGNI on clone management.
- Sequential: the manager runs one job at a time; further requests queue.

- [ ] **Step 1: Failing tests for the job manager**

```ts
// packages/cli/src/__tests__/job-manager.test.ts
import { describe, expect, it } from "vitest";
import { JobManager } from "../generation/job-manager.js";

describe("JobManager", () => {
	it("runs jobs sequentially", async () => {
		const order: string[] = [];
		const manager = new JobManager(async (job) => {
			order.push(`start:${job.prUrl}`);
			await new Promise((r) => setTimeout(r, 10));
			order.push(`end:${job.prUrl}`);
			return "run-1";
		});
		const a = manager.enqueue({ prUrl: "https://github.com/a/a/pull/1", repoRoot: "/a", model: "sonnet" });
		const b = manager.enqueue({ prUrl: "https://github.com/b/b/pull/2", repoRoot: "/b", model: "sonnet" });
		await manager.settled();
		expect(order).toEqual([
			"start:https://github.com/a/a/pull/1",
			"end:https://github.com/a/a/pull/1",
			"start:https://github.com/b/b/pull/2",
			"end:https://github.com/b/b/pull/2",
		]);
		expect(manager.get(a)?.status).toBe("succeeded");
		expect(manager.get(a)?.runId).toBe("run-1");
		expect(manager.get(b)?.status).toBe("succeeded");
	});

	it("records failures without stopping the queue", async () => {
		const manager = new JobManager(async (job) => {
			if (job.prUrl.includes("bad")) throw new Error("boom");
			return "run-2";
		});
		const bad = manager.enqueue({ prUrl: "https://github.com/x/x/pull/9?bad", repoRoot: "/x", model: "sonnet" });
		const good = manager.enqueue({ prUrl: "https://github.com/y/y/pull/3", repoRoot: "/y", model: "sonnet" });
		await manager.settled();
		expect(manager.get(bad)?.status).toBe("failed");
		expect(manager.get(bad)?.error).toBe("boom");
		expect(manager.get(good)?.status).toBe("succeeded");
	});
});
```

Run: `pnpm test -- job-manager` — Expected: FAIL

- [ ] **Step 2: Implement the manager**

The runner is injected so tests never spawn a real agent; the class owns queue + state (OOP per AGENTS.md):

```ts
// packages/cli/src/generation/job-manager.ts
import { randomUUID } from "node:crypto";

export const JOB_STATUS = {
	QUEUED: "queued",
	RUNNING: "running",
	SUCCEEDED: "succeeded",
	FAILED: "failed",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export interface JobRequest {
	prUrl: string;
	repoRoot: string;
	model: string;
}

export interface Job extends JobRequest {
	id: string;
	status: JobStatus;
	runId: string | null;
	error: string | null;
}

/** Returns the new runId on success. */
export type JobRunner = (job: JobRequest) => Promise<string>;

export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private readonly queue: string[] = [];
	private running = false;
	private idle: Promise<void> = Promise.resolve();
	private resolveIdle: () => void = () => {};

	constructor(private readonly runner: JobRunner) {}

	enqueue(request: JobRequest): string {
		const id = randomUUID();
		this.jobs.set(id, { ...request, id, status: JOB_STATUS.QUEUED, runId: null, error: null });
		this.queue.push(id);
		if (!this.running) {
			this.idle = new Promise((resolve) => {
				this.resolveIdle = resolve;
			});
			void this.drain();
		}
		return id;
	}

	get(id: string): Job | null {
		return this.jobs.get(id) ?? null;
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	/** Resolves when the queue is empty. For tests and graceful shutdown. */
	settled(): Promise<void> {
		return this.running ? this.idle : Promise.resolve();
	}

	private async drain(): Promise<void> {
		this.running = true;
		let id = this.queue.shift();
		while (id !== undefined) {
			const job = this.jobs.get(id);
			if (job) {
				job.status = JOB_STATUS.RUNNING;
				try {
					job.runId = await this.runner(job);
					job.status = JOB_STATUS.SUCCEEDED;
				} catch (err) {
					job.status = JOB_STATUS.FAILED;
					job.error = err instanceof Error ? err.message : String(err);
				}
			}
			id = this.queue.shift();
		}
		this.running = false;
		this.resolveIdle();
	}
}

/**
 * The real runner: headless claude with the stage-chapters skill, told to
 * finish with `stagereview import` (never `show` — the daemon already serves).
 * Runs in the repo's clone so prep/import resolve the right git state.
 */
export function claudeRunner(job: JobRequest): Promise<string> {
	return new Promise((resolve, reject) => {
		const prompt = [
			`/stage-chapters --pr ${job.prUrl}`,
			"IMPORTANT: this is a headless run for the Stage dashboard.",
			'In the final step, run `stagereview import` (same arguments as `show`) instead of `stagereview show`,',
			"and print ONLY the runId it outputs as your last line.",
		].join("\n");
		import("node:child_process").then(({ execFile }) => {
			execFile(
				"claude",
				["-p", prompt, "--model", job.model],
				{ cwd: job.repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 15 * 60 * 1000 },
				(err, stdout) => {
					if (err) {
						reject(new Error(err.message));
						return;
					}
					const lines = stdout.trim().split("\n");
					const runId = lines[lines.length - 1]?.trim();
					if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
						reject(new Error(`Agent did not return a runId. Last output: ${runId ?? "(empty)"}`));
						return;
					}
					resolve(runId);
				},
			);
		});
	});
}
```

(Use a static top-level `import { execFile } from "node:child_process"` — the dynamic import above is shown only to keep the snippet self-contained; write it as a normal import.)

- [ ] **Step 3: Run manager tests**

Run: `pnpm test -- job-manager` — Expected: PASS. Commit:

```bash
git add packages/cli/src/generation/job-manager.ts packages/cli/src/__tests__/job-manager.test.ts
git commit -m "feat(cli): sequential generation job manager for headless claude runs"
```

- [ ] **Step 4: Routes**

```ts
// packages/cli/src/routes/generate.ts
import { desc, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import type { JobManager } from "../generation/job-manager.js";
import { parseGitHubRepo } from "../github/repo.js";
import type { Route } from "../server.js";
import { parseJsonBody, writeJson } from "./json.js";
import { enforceSameOrigin } from "./pull-request-shared.js";

const GenerateBodySchema = z.object({
	prUrl: z.string().url(),
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	model: z.enum(["sonnet", "opus", "haiku"]).default("sonnet"),
});

export function generateRoutes(db: StageDb, jobs: JobManager): Route[] {
	return [
		{
			method: "POST",
			pattern: "/api/generate",
			handler: async (req, res) => {
				if (!enforceSameOrigin(req, res)) return;
				const body = await parseJsonBody(req, res, GenerateBodySchema);
				if (!body) return;
				// Only repos stage has seen before have a known local clone.
				const runs = db
					.select()
					.from(chapterRun)
					.where(isNotNull(chapterRun.originUrl))
					.orderBy(desc(chapterRun.generatedAt))
					.all();
				const match = runs.find((run) => {
					const repo = parseGitHubRepo(run.originUrl);
					return repo !== null && `${repo.owner}/${repo.repo}` === body.repository;
				});
				if (!match) {
					writeJson(res, 422, {
						error: `No local clone known for ${body.repository}. Run /stage-chapters once from a clone of it first.`,
					});
					return;
				}
				const jobId = jobs.enqueue({ prUrl: body.prUrl, repoRoot: match.repoRoot, model: body.model });
				writeJson(res, 202, { jobId });
			},
		},
		{
			method: "GET",
			pattern: "/api/generate/:jobId",
			handler: (_req, res, params) => {
				const job = params.jobId ? jobs.get(params.jobId) : null;
				if (!job) {
					writeJson(res, 404, { error: "Job not found" });
					return;
				}
				writeJson(res, 200, {
					id: job.id,
					status: job.status,
					runId: job.runId,
					error: job.error,
				});
			},
		},
	];
}
```

Check `enforceSameOrigin`'s actual signature in `pull-request-shared.ts` before using it — mirror how `pull-request-mutations.ts` calls it exactly.

Wire into `start.ts`:

```ts
import { claudeRunner, JobManager } from "./generation/job-manager.js";
import { generateRoutes } from "./routes/generate.js";
// inside start(), before startServer:
const jobs = new JobManager(claudeRunner);
// add ...generateRoutes(db, jobs) to routes
```

- [ ] **Step 5: Verify, lint, commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` — Expected: PASS

```bash
git add packages/cli/src/routes/generate.ts packages/cli/src/start.ts
git commit -m "feat(cli): POST /api/generate spawning headless claude with import handoff"
```

### Task 7: Dashboard UI

**Files:**
- Create: `packages/web/src/lib/use-runs.ts`
- Create: `packages/web/src/lib/use-inbox.ts`
- Create: `packages/web/src/components/dashboard/run-list.tsx`
- Create: `packages/web/src/components/dashboard/inbox-list.tsx`
- Modify: `packages/web/src/app/index.tsx`
- Test: `packages/web/src/lib/__tests__/` (mapper/hook tests per TESTING.md — mirror existing web test style)

- [ ] **Step 1: Hooks (mirror `use-github-threads.ts` exactly)**

```ts
// packages/web/src/lib/use-runs.ts
import { type RunListResponse, RunListResponseSchema } from "@stagereview/types/run-summary";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

export function useRuns() {
	return useQuery<RunListResponse>({
		queryKey: ["runs"],
		queryFn: async () => RunListResponseSchema.parse(await jsonFetch<unknown>("/api/runs")),
	});
}
```

```ts
// packages/web/src/lib/use-inbox.ts
import { type InboxResponse, InboxResponseSchema } from "@stagereview/types/inbox";
import { useMutation, useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

export function useInbox() {
	return useQuery<InboxResponse>({
		queryKey: ["inbox"],
		queryFn: async () => InboxResponseSchema.parse(await jsonFetch<unknown>("/api/inbox")),
		staleTime: 60_000,
	});
}

export interface GenerateInput {
	prUrl: string;
	repository: string;
}

export function useGenerate() {
	return useMutation({
		mutationFn: async (input: GenerateInput) => {
			const raw = await jsonFetch<unknown>("/api/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			return raw as { jobId: string };
		},
	});
}
```

(If `jsonFetch`'s generic already validates, keep the boundary-Zod pattern anyway — it's the established style. For the mutation result, add a small Zod schema instead of the cast shown: `z.object({ jobId: z.string() }).parse(raw)` — no type assertions per AGENTS.md.)

- [ ] **Step 2: Components**

Keep them simple; shadcn primitives already exist under `components/ui/`. `run-list.tsx` renders `useRuns()` rows as `<Link to="/runs/$runId" params={{ runId }}>` with repoName, `#prNumber` badge when non-null, chapterCount, and a relative `generatedAt` (reuse the existing date-format helper in `lib/format.ts` if one exists — check first). `inbox-list.tsx` renders `useInbox()` rows: title, repository, author, draft badge; a "Open review" link when `runId` is non-null, otherwise a "Generate chapters" button that calls `useGenerate()` and then polls `GET /api/generate/:jobId` every 3s until `succeeded`/`failed` (use TanStack Query's `refetchInterval` on a job-status query keyed by jobId, enabled only while a jobId exists). On success, invalidate `["runs"]` and `["inbox"]` and show the "Open review" link. Show a confirm dialog before generating: "This runs 1 Claude agent session against your usage limits."

When `available: false`, render the `reason` with a hint that `gh auth login` may be needed.

- [ ] **Step 3: Replace the index route**

```tsx
// packages/web/src/app/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { InboxList } from "@/components/dashboard/inbox-list";
import { RunList } from "@/components/dashboard/run-list";
import { Topbar } from "@/components/layout/topbar";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	return (
		<>
			<Topbar />
			<main className="mx-auto w-full max-w-4xl flex-1 space-y-10 p-6 lg:p-8">
				<section>
					<h2 className="mb-3 font-semibold text-base">Waiting on your review</h2>
					<InboxList />
				</section>
				<section>
					<h2 className="mb-3 font-semibold text-base">Recent runs</h2>
					<RunList />
				</section>
			</main>
		</>
	);
}
```

- [ ] **Step 4: Verify end to end**

Run: `pnpm build && node packages/cli/dist/index.js start` — Expected: browser opens the dashboard; past runs listed; inbox populated (or a clear unavailable message); clicking a run opens the existing review UI.

Run: `pnpm test && pnpm typecheck && pnpm lint` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): dashboard home with runs list and PR inbox"
```

### Task 8: Update stage-chapters skill for headless/import mode

**Files:**
- Modify: `skills/stage-chapters/SKILL.md`

- [ ] **Step 1: Document the import path**

Add a short section: when invoked headlessly for the dashboard (the prompt says so), replace the final `stagereview show "$AGENT_OUTPUT"` with `stagereview import "$AGENT_OUTPUT" --pr <ref>` (same scope flags as prep), and print the emitted runId as the last output line. All other steps unchanged.

- [ ] **Step 2: Commit**

```bash
git add skills/stage-chapters/SKILL.md
git commit -m "docs(skill): document headless import mode for the dashboard"
```

---

## Self-Review Notes

- Spec coverage: daemon (`start`, Task 4), runs list (Tasks 1–2), inbox (Task 5), one-click generation with sequential queue + usage confirm (Tasks 6–7), non-blocking import handoff (Tasks 3, 8). Model default sonnet enforced in `GenerateBodySchema`.
- Known verify-before-trusting points (flagged inline): `@stagereview/types` subpath-export mechanics (Task 1), the existing test harness helpers (Tasks 2, 3), `enforceSameOrigin` signature (Task 6), `jsonFetch` location/shape (Task 7).
- Type consistency: `JobRequest`/`Job`/`JOB_STATUS` defined once in Task 6 and used by routes; `RunSummary`/`InboxPullRequest` defined in types and used by both sides.
