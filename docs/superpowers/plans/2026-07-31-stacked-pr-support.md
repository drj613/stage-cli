# Stacked PR Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stage stack-aware for GitHub's stacked pull requests (public preview since 2026-07-30): detect the stack from any PR in it, show a stack navigator with per-layer run links and staleness badges, block review submission against a moved head, and support batch chapter generation for a whole stack.

**Architecture:** Stack data is fetched live via GraphQL from a PR number (never stored in SQLite — stacks mutate constantly via `gh stack sync` cascading rebases; this matches the existing live-fetch pattern for review threads/checks). A run is already a correct single-layer review — mid-stack PRs diff against the layer below because `resolvePullRequestRefs` uses `baseRefName`. The new pieces: a `github/stack.ts` reader, a `GET /api/runs/:runId/stack` route that joins live stack layers to existing runs by `prNumber` + repo, a `StackNavigator` UI component, a stale-head guard on review submission, and a batch mode in the stage-chapters skill.

**Tech Stack:** `gh api graphql` (existing `gh()` wrapper), Zod at boundaries, Drizzle, React 19 + TanStack Query, Vitest.

**Primary use case (locked in session):** reviewing other people's remote PRs from a PR number/URL. No local `gh stack` tracking state is assumed; do NOT build on `gh stack view --json` (requires local stack tracking) — GraphQL from the PR number is the only detection path.

---

## ⚠️ Task 0: Verify the preview GraphQL schema (do this first)

The stacked-PRs API is in public preview (shipped 2026-07-30). The field names below are the plan's best guess and MUST be verified before writing code.

- [ ] **Step 1: Introspect**

Run from any GitHub-remote repo clone:

```bash
gh api graphql -f query='query { __type(name: "PullRequest") { fields { name } } }' | tr ',' '\n' | grep -i stack
```

Also check the docs page: https://docs.github.com/en/graphql — search for "stack" object types, and whether a preview `Accept` header or feature flag is required.

- [ ] **Step 2: Record findings**

Write the actual field/type names into this plan (replace every `STACK_QUERY` occurrence and the Zod schema in Task 2) before proceeding. If GraphQL requires a preview header that `gh api graphql` can't send, fall back to the REST stack endpoints (the changelog documents list/read endpoints) with the same wire shape — only `github/stack.ts` changes; everything downstream is insulated by the `StackInfo` type.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/types/src/stack.ts` | Create | Wire types: `StackLayer`, `StackResponse` |
| `packages/types/src/index.ts` | Modify | Barrel/subpath export |
| `packages/cli/src/github/stack.ts` | Create | GraphQL stack fetch + pure mapper |
| `packages/cli/src/routes/stack.ts` | Create | `GET /api/runs/:runId/stack` |
| `packages/cli/src/show.ts` + `start.ts` | Modify | Register `stackRoutes` |
| `packages/cli/src/routes/github-threads.ts` | Modify | Stale-head guard on `POST /api/runs/:runId/review` |
| `packages/web/src/lib/use-stack.ts` | Create | Stack query hook |
| `packages/web/src/components/pull-request/stack-navigator.tsx` | Create | Ordered layer list with status/links/badges |
| `packages/web/src/routes/pull-request-layout.tsx` | Modify | Render navigator when in a stack |
| `skills/stage-chapters/SKILL.md` | Modify | Batch "chapter the whole stack" mode |

---

### Task 1: Stack wire types

**Files:**
- Create: `packages/types/src/stack.ts`
- Modify: `packages/types/src/index.ts` (+ `package.json` subpath export, matching how `pull-request` is exported)

- [ ] **Step 1: Create the types**

```ts
// packages/types/src/stack.ts
import { z } from "zod";

export const StackLayerSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	isDraft: z.boolean(),
	headRefOid: z.string(),
	url: z.string(),
	/** 1-based position, 1 = bottom (targets trunk). */
	position: z.number(),
	/** Existing stage run for this layer, else null. */
	runId: z.string().nullable(),
	/** True when the layer's live head no longer matches its run's headSha. */
	stale: z.boolean(),
});
export type StackLayer = z.infer<typeof StackLayerSchema>;

export const StackResponseSchema = z.union([
	z.object({ inStack: z.literal(false) }),
	z.object({
		inStack: z.literal(true),
		/** This run's PR number, so the UI can highlight the current layer. */
		currentPrNumber: z.number(),
		layers: z.array(StackLayerSchema),
	}),
]);
export type StackResponse = z.infer<typeof StackResponseSchema>;
```

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm typecheck` — Expected: PASS

```bash
git add packages/types/src/stack.ts packages/types/src/index.ts packages/types/package.json
git commit -m "feat(types): stack wire types for stacked PR support"
```

### Task 2: `github/stack.ts` — fetch + pure mapper

**Files:**
- Create: `packages/cli/src/github/stack.ts`
- Test: `packages/cli/src/__tests__/stack.test.ts`

- [ ] **Step 1: Write failing tests for the mapper (pure — no gh in tests)**

```ts
// packages/cli/src/__tests__/stack.test.ts
import { describe, expect, it } from "vitest";
import { mapStackLayers } from "../github/stack.js";

const RAW_LAYERS = [
	{ number: 11, title: "db schema", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), url: "https://github.com/o/r/pull/11" },
	{ number: 12, title: "api", state: "OPEN", isDraft: true, headRefOid: "b".repeat(40), url: "https://github.com/o/r/pull/12" },
];

describe("mapStackLayers", () => {
	it("assigns bottom-up positions and joins runs with staleness", () => {
		const runFor = (prNumber: number) =>
			prNumber === 11 ? { runId: "run-11", headSha: "a".repeat(40) } : null;
		const layers = mapStackLayers(RAW_LAYERS, runFor);
		expect(layers).toEqual([
			{ number: 11, title: "db schema", state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), url: "https://github.com/o/r/pull/11", position: 1, runId: "run-11", stale: false },
			{ number: 12, title: "api", state: "OPEN", isDraft: true, headRefOid: "b".repeat(40), url: "https://github.com/o/r/pull/12", position: 2, runId: null, stale: false },
		]);
	});

	it("marks a layer stale when its run's headSha no longer matches", () => {
		const runFor = () => ({ runId: "run-11", headSha: "0".repeat(40) });
		const layers = mapStackLayers(RAW_LAYERS, runFor);
		expect(layers[0]?.stale).toBe(true);
	});
});
```

Run: `pnpm test -- stack` — Expected: FAIL (module missing)

- [ ] **Step 2: Implement**

```ts
// packages/cli/src/github/stack.ts
import type { StackLayer } from "@stagereview/types/stack";
import { z } from "zod";
import { gh } from "./exec.js";
import type { GitHubRepo } from "./repo.js";

// ⚠️ Task 0: replace field names with the verified preview schema.
const STACK_QUERY = `query GetStack($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stack {
        pullRequests(first: 50) {
          nodes { number title state isDraft headRefOid url }
        }
      }
    }
  }
}`;

const RawLayerSchema = z.object({
	number: z.number(),
	title: z.string(),
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	isDraft: z.boolean(),
	headRefOid: z.string(),
	url: z.string(),
});
export type RawStackLayer = z.infer<typeof RawLayerSchema>;

const GhStackSchema = z.object({
	data: z.object({
		repository: z
			.object({
				pullRequest: z
					.object({
						stack: z
							.object({ pullRequests: z.object({ nodes: z.array(RawLayerSchema) }) })
							.nullable(),
					})
					.nullable(),
			})
			.nullable(),
	}),
});

export interface RunLink {
	runId: string;
	headSha: string;
}

/** Nodes are assumed bottom-first (verify in Task 0; reverse here if top-first). */
export function mapStackLayers(
	raw: RawStackLayer[],
	runFor: (prNumber: number) => RunLink | null,
): StackLayer[] {
	return raw.map((layer, i) => {
		const run = runFor(layer.number);
		return {
			...layer,
			position: i + 1,
			runId: run?.runId ?? null,
			stale: run !== null && run.headSha !== layer.headRefOid,
		};
	});
}

/**
 * Live stack membership for a PR. Returns null when the PR is not in a stack
 * or on any failure (preview API missing, gh unauthenticated, non-GitHub
 * remote already filtered by caller) — stack UI must never break the review.
 */
export async function getStackLayers(
	repoRoot: string,
	repo: GitHubRepo,
	prNumber: number,
): Promise<RawStackLayer[] | null> {
	try {
		const stdout = await gh(
			[
				"api",
				"graphql",
				"-f",
				`query=${STACK_QUERY}`,
				"-F",
				`owner=${repo.owner}`,
				"-F",
				`repo=${repo.repo}`,
				"-F",
				`number=${prNumber}`,
			],
			repoRoot,
		);
		const parsed = GhStackSchema.safeParse(JSON.parse(stdout));
		if (!parsed.success) return null;
		const nodes = parsed.data.data.repository?.pullRequest?.stack?.pullRequests.nodes;
		if (!nodes || nodes.length === 0) return null;
		return nodes;
	} catch {
		return null;
	}
}
```

(Note the `-f`-for-strings / `-F`-for-typed-vars split follows the fix in commit a719691 — string GraphQL vars use `-f`.)

- [ ] **Step 3: Run tests and commit**

Run: `pnpm test -- stack && pnpm typecheck && pnpm lint` — Expected: PASS

```bash
git add packages/cli/src/github/stack.ts packages/cli/src/__tests__/stack.test.ts
git commit -m "feat(cli): fetch and map stacked-PR layers via GraphQL"
```

### Task 3: `GET /api/runs/:runId/stack` route

**Files:**
- Create: `packages/cli/src/routes/stack.ts`
- Modify: `packages/cli/src/show.ts` (and `start.ts` if the dashboard plan has landed) to register
- Test: `packages/cli/src/__tests__/stack-route.test.ts`

- [ ] **Step 1: Failing test**

Mirror the sibling route-test harness. Assertions: run without `prNumber` → `{ inStack: false }` without shelling to gh (test by injecting a fetcher that throws if called); run with `prNumber` whose fetcher returns two raw layers, one matching another run in the DB → 200 with `inStack: true`, `currentPrNumber`, joined `runId`, correct `stale`.

To make the route testable without gh, `stackRoutes` takes the fetcher as an optional parameter defaulting to the real one:

- [ ] **Step 2: Implement**

```ts
// packages/cli/src/routes/stack.ts
import type { StackResponse } from "@stagereview/types/stack";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { StageDb } from "../db/client.js";
import { chapterRun } from "../db/schema/index.js";
import { parseGitHubRepo } from "../github/repo.js";
import { getStackLayers, mapStackLayers, type RawStackLayer, type RunLink } from "../github/stack.js";
import type { GitHubRepo } from "../github/repo.js";
import type { Route } from "../server.js";
import { writeJson } from "./json.js";
import { resolveRun } from "./pull-request-shared.js";

type StackFetcher = (
	repoRoot: string,
	repo: GitHubRepo,
	prNumber: number,
) => Promise<RawStackLayer[] | null>;

export function stackRoutes(db: StageDb, fetchStack: StackFetcher = getStackLayers): Route[] {
	return [
		{
			method: "GET",
			pattern: "/api/runs/:runId/stack",
			handler: async (_req, res, params) => {
				const notInStack: StackResponse = { inStack: false };
				const run = resolveRun(db, params, res);
				if (!run) return;
				const repo = parseGitHubRepo(run.originUrl);
				if (!repo || run.prNumber === null) {
					writeJson(res, 200, notInStack);
					return;
				}
				const raw = await fetchStack(run.repoRoot, repo, run.prNumber);
				if (!raw) {
					writeJson(res, 200, notInStack);
					return;
				}
				// Newest run per layer PR, same repo (originUrl match via owner/repo).
				const candidateRuns = db
					.select()
					.from(chapterRun)
					.where(isNotNull(chapterRun.prNumber))
					.orderBy(desc(chapterRun.generatedAt))
					.all();
				const linkFor = (prNumber: number): RunLink | null => {
					for (const candidate of candidateRuns) {
						if (candidate.prNumber !== prNumber) continue;
						const candidateRepo = parseGitHubRepo(candidate.originUrl);
						if (!candidateRepo) continue;
						if (candidateRepo.owner === repo.owner && candidateRepo.repo === repo.repo) {
							return { runId: candidate.id, headSha: candidate.headSha };
						}
					}
					return null;
				};
				const body: StackResponse = {
					inStack: true,
					currentPrNumber: run.prNumber,
					layers: mapStackLayers(raw, linkFor),
				};
				writeJson(res, 200, body);
			},
		},
	];
}
```

Register `...stackRoutes(db)` in `show.ts`'s route array (and `start.ts` if present).

- [ ] **Step 3: Run tests and commit**

Run: `pnpm test -- stack-route && pnpm typecheck && pnpm lint` — Expected: PASS

```bash
git add packages/cli/src/routes/stack.ts packages/cli/src/show.ts packages/cli/src/__tests__/stack-route.test.ts
git commit -m "feat(cli): GET /api/runs/:runId/stack joining live layers to local runs"
```

### Task 4: Stale-head guard on review submission

**Files:**
- Modify: `packages/cli/src/routes/github-threads.ts` (the `POST /api/runs/:runId/review` handler)
- Test: extend the existing github-threads route tests

**Why:** after the author runs `gh stack sync`, every layer's head moves; submitting a review anchored to the run's old `headSha` would attach comments to lines the author already rewrote. This protects all `--pr` runs, not just stacked ones.

- [ ] **Step 1: Failing test**

In the existing review-submit test file, add: when the live PR `headRefOid` ≠ the run's `headSha`, the handler responds 409 with `{ error: "The pull request head has moved since this run was generated. Regenerate chapters before submitting." }` and does not call the submit mutation. When they match (or the live head can't be fetched — degrade open, matching the existing never-break-the-UI philosophy for reads but see decision below), submission proceeds.

**Decision (encode in test):** fail **closed** on a confirmed mismatch; proceed when the live head is unknowable (gh failure) — blocking all submits during a GitHub outage is worse, and the reviewer explicitly clicked submit.

- [ ] **Step 2: Implement**

In the review-submit handler, before bundling pending threads (reuse `getPullRequest` — it already returns `head.sha`):

```ts
const livePr = await getPullRequest(run.repoRoot, run.originUrl, run.prNumber);
if (livePr && livePr.head.sha !== run.headSha) {
	writeJson(res, 409, {
		error:
			"The pull request head has moved since this run was generated. Regenerate chapters before submitting.",
	});
	return;
}
```

- [ ] **Step 3: Surface the 409 in the web submit flow**

`use-github-threads.ts` submit already rejects on failure and callers toast the message — verify the 409 body's `error` string reaches the toast (check `jsonFetch`'s error handling; adjust the toast call site in `review-toolbar.tsx` if it swallows response bodies).

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint` — Expected: PASS

```bash
git add packages/cli/src/routes/github-threads.ts packages/cli/src/__tests__ packages/web/src
git commit -m "feat: reject review submission when the PR head moved past the run"
```

### Task 5: Stack navigator UI

**Files:**
- Create: `packages/web/src/lib/use-stack.ts`
- Create: `packages/web/src/components/pull-request/stack-navigator.tsx`
- Modify: `packages/web/src/routes/pull-request-layout.tsx`

- [ ] **Step 1: Hook (mirror `use-github-threads.ts`)**

```ts
// packages/web/src/lib/use-stack.ts
import { type StackResponse, StackResponseSchema } from "@stagereview/types/stack";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "./use-view-state";

export function useStack(runId: string) {
	return useQuery<StackResponse>({
		queryKey: ["stack", runId],
		queryFn: async () =>
			StackResponseSchema.parse(
				await jsonFetch<unknown>(`/api/runs/${encodeURIComponent(runId)}/stack`),
			),
		enabled: runId !== "",
		staleTime: Number.POSITIVE_INFINITY, // refresh on demand, like github-threads
	});
}
```

- [ ] **Step 2: Component**

`stack-navigator.tsx` renders nothing when `inStack: false` (or while loading — the navigator is enhancement, never a loading wall). When in a stack, render an ordered list **bottom-up** ("read from the bottom"), each row:

- position + title + `#number`, state badge (open/draft/merged — reuse the existing PR state badge component in `components/pull-request/` if one exists; check before writing a new one),
- highlight the row where `number === currentPrNumber`,
- `runId` non-null → `<Link to="/runs/$runId" params={{ runId: layer.runId }}>` "Open review"; a `stale` amber badge "Outdated — regenerate" when stale,
- `runId` null → link to `layer.url` on GitHub plus a hint ("no chapters yet — run /stage-chapters --pr {url}"). If the dashboard plan's generate endpoint exists, render its Generate button instead.

Place it in `pull-request-layout.tsx` alongside the existing PR overview sidebar (match its card chrome — see commit 44da7d1's shared thread-card chrome pattern for the house style).

- [ ] **Step 3: Verify visually**

Run a `--pr` review against a real stacked PR (create a two-layer test stack in a scratch repo with `gh stack init && gh stack add && gh stack submit` if none available). Expected: navigator lists both layers, current highlighted, other layer links to GitHub.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
git add packages/web/src
git commit -m "feat(web): stack navigator with per-layer run links and stale badges"
```

### Task 6: Batch stack mode in the stage-chapters skill

**Files:**
- Modify: `skills/stage-chapters/SKILL.md`

- [ ] **Step 1: Add the stack workflow section**

After PR resolution, the skill checks stack membership (`gh api graphql` with the Task 0-verified query — from the reviewer's clone, no local stack tracking). If in a stack with N open layers:

1. Tell the user: "This PR is layer k of N. Chapter the whole stack? That runs N sequential generation passes against your usage limits." Proceed only on yes (or when the invocation already said "whole stack").
2. Bottom-up, for each open layer: `stagereview prep --pr <layer-url>` → generate chapters → `stagereview show`/`import --pr <layer-url>` (import when headless per the dashboard plan; show for the last layer interactively).
3. The bottom layer's prologue gets a stack preamble: what the whole stack achieves, why it was split, and "review bottom-up starting here".

- [ ] **Step 2: Commit**

```bash
git add skills/stage-chapters/SKILL.md
git commit -m "docs(skill): batch chapter generation for stacked PRs"
```

---

## Self-Review Notes

- Spec coverage: detection from a PR number (Tasks 0, 2), navigator with run links + stale badges (Tasks 3, 5), submit guard (Task 4), batch generation with usage confirm (Task 6). Explicit non-goals honored: no SQLite persistence of stacks, no combined cross-layer diff, no `gh stack view` local-tracking dependency.
- Biggest risk is Task 0: every GraphQL field name in Tasks 2–3 is provisional until introspected. The `RawStackLayer` boundary confines the blast radius to `github/stack.ts`.
- Ordering assumption (nodes bottom-first) is flagged in `mapStackLayers` and must be settled in Task 0.
- Cross-plan dependency: Tasks 3/5 mention `start.ts` and the Generate button from the dashboard plan — both are optional grafts; this plan stands alone against `show.ts`.
