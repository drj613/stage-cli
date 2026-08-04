# Browsing pull requests in the Stage dashboard

Design doc — 2026-08-04

## Problem

`stagereview start` serves a dashboard, but the only way into a pull request is
the inbox, which lists `gh search prs --review-requested=@me`. That leaves out
your own PRs and PRs you're assigned to, and there's no way to reach a PR that
nobody asked you to review. Generation is also gated on `RunIndex.repoRootFor()`,
which only knows repos Stage has already run in — so on a fresh install every PR
is unreachable, including ones in repos cloned on disk.

The hosted version of this product put a "review in Stage" link on every PR and
let you browse the repos you had access to. We want that, minus the server-side
clones it depended on.

## What we're building

Three PR lists on the dashboard — waiting on your review, assigned to you, your
own open PRs — plus a browse tier one click away for reaching any PR in the orgs
you work in. Every PR has a stable URL. Opening a PR without chapters generates
them on the spot.

## Constraint that shapes everything

Stage reads diffs and file contents from a **local git clone**. The diff route
resolves file contents through `git show <ref>:<path>`, and both `prep` and the
generation agent run git commands with the clone as `cwd`. There is no
server-side checkout to fall back on.

So Stage can only chapter a PR whose repo is on disk. Rather than clone on the
user's behalf, we make the requirement visible: repos you haven't cloned are
listed and clearly marked, and opening one of their PRs tells you what to clone.

Bare clones don't count — `git rev-parse --show-toplevel` needs a working tree.

## Decisions

| Question | Decision |
|---|---|
| Repos not on disk | Listed and marked "not cloned"; PR page shows the `git clone` command. Stage never clones. |
| Finding clones | Configured search roots, editable from both the CLI and the dashboard. |
| Browse tree scope | Owners derived from the clone index; within an owner, all repos via `gh repo list`. |
| Dashboard sections | Review-requested, assigned, authored, recent runs. |
| PR states listed | Open, including drafts. |
| PR URL | `/pr/$owner/$repo/$number` — stable, resolves to the newest run or generates. |
| On-demand chaptering | Generates immediately on click, no confirmation dialog. |
| Concurrency | Stays serialized; queue position is shown. |
| Persisted state | Search roots in SQLite. The scan result is in-memory only. |

Search roots live in the existing global DB (`~/.stage/db.sqlite`) so there's one
place for persisted state and migrations are already wired. The `owner/repo →
path` map is never persisted: the scan is fast, and a stale path that points
generation at a directory that no longer exists is worse than rescanning.

## Backend

### `packages/cli/src/clones/`

**`clone-root-store.ts`** — Drizzle CRUD over a new `clone_root` table (`path`
primary key, `addedAt`). Add rejects non-absolute paths and paths that aren't
directories, so a typo fails at the boundary instead of yielding zero repos.

**`clone-index.ts`** — the `CloneIndex` class. Interface:

- `pathFor(nameWithOwner): string | null`
- `owners(): { owner: string; cloneCount: number }[]`
- `has(nameWithOwner): boolean`

Built by walking each root breadth-first to a bounded depth (default 4),
stopping descent at any directory that is itself a repo, and skipping
`node_modules` and dot-directories. For each hit it reads `.git/config` directly
and parses the `[remote "origin"]` url — no `git` subprocess per repo, so
hundreds of clones scan in well under a second. A `.git` *file* (linked
worktree) is resolved through its `gitdir:` pointer to the main clone's config so
worktrees don't hide a repo. Bare clones and non-GitHub remotes are skipped.

The walk tracks visited real paths so a symlink loop terminates, and skips
unreadable directories rather than aborting — a permissions error on one folder
must not kill the scan.

**`clone-registry.ts`** — owns the roots store and the current index, exposes
`rescan()`. One instance per server process, built at startup, injected into the
routes that need it.

### `packages/cli/src/github/`

- `inbox.ts` generalizes into `pr-search.ts`: `searchPullRequests(filter)`, where
  filter is a `PR_FILTER` const object (`REVIEW_REQUESTED`, `AUTHOR`, `ASSIGNEE`)
  mapping to the corresponding `gh search prs` flag. The existing Zod row schema
  and drop-malformed-rows-with-a-logged-count behavior carry over unchanged.
- `repos.ts`: `listOrgRepos(owner)` via `gh repo list <owner> --json`.
- `pr-list.ts`: `listRepoPullRequests(nameWithOwner)` via `gh pr list --repo`,
  open PRs including drafts.

### Routes

| Route | Behavior |
|---|---|
| `GET /api/pull-requests?filter=…` | Replaces `/api/inbox`. Same `{available, reason}` / `{available, pullRequests}` envelope. Rows carry `runId` (from `RunIndex`) and `cloned` (from `CloneIndex`). |
| `GET /api/owners` | Distinct owners from the clone index with a clone count each. No `gh` call. |
| `GET /api/owners/:owner/repos` | `gh repo list`, each repo marked `cloned`. |
| `GET /api/repos/:owner/:repo/pulls` | That repo's open PRs, each with `runId` and `cloned`. |
| `GET /api/pull-requests/:owner/:repo/:number` | Resolution state, no side effects: `{state: "ready", runId}`, `{state: "generating", jobId}`, `{state: "needs-generation"}`, or `{state: "no-clone", nameWithOwner}`. |
| `GET/POST/DELETE /api/clone-roots` | Root management. Writes go through the existing `enforceSameOrigin` guard. |
| `POST /api/clone-roots/rescan` | Rebuilds the index, returns repo and owner counts. |
| `POST /api/generate` | Contract unchanged. Resolves `repoRoot` from `CloneIndex` first, falling back to `RunIndex` so repos Stage has already run in keep working even outside a search root. |
| `GET /api/generate/:jobId` | `GenerationJob` gains `queuePosition`: `null` when running or terminal, otherwise 1-based. |

The resolution endpoint has no side effects. Generating on click is client
behavior: the PR page reads state and, on `needs-generation`, immediately POSTs
`/api/generate`. Keeping GET safe means a prefetch or a refresh can't spend an
agent session.

Generation stays serialized. `JobManager` grows `positionOf(id)` reading its
existing queue array.

### CLI

`stagereview config add-root <path>`, `remove-root <path>`, `list-roots`.

## Frontend

### Routes

```
/                                  dashboard — 3 PR sections + recent runs
/pr/$owner/$repo/$number           resolver — the stable PR address
/browse                            owners (from the clone index)
/browse/$owner                     repos in that owner
/browse/$owner/$repo               open PRs in that repo
/settings                          clone roots
```

`/runs/$runId` and its children are untouched.

### Dashboard

Four sections in order: Waiting on your review, Assigned to you, Your open PRs,
Recent runs. The three PR sections share one `PullRequestList` component
parameterized by filter, each fetching independently so a slow or failing `gh`
call degrades one section rather than the page.

Rows are deduped top-down: a PR that is both assigned to you and authored by you
appears once, in the higher section. Empty sections collapse to a single muted
line instead of a full empty-state card, so four quiet sections don't dominate
the page.

A row is a link to `/pr/$owner/$repo/$number` and nothing else — no generate
button, no dialog. The click *is* the decision to chapter. Rows for uncloned
repos link there too and land on the no-clone explanation.

### Browse

Deliberately a tier down: a topbar link, not a dashboard section.

- `/browse` — owners from the clone index, so it's instant and never empty when
  you have clones.
- `/browse/$owner` — that owner's repos from `gh repo list`, with a `Not cloned`
  badge where applicable.
- `/browse/$owner/$repo` — open PRs, with a `Chaptered` badge on ones that
  already have runs.

### Resolver page

Reads `GET /api/pull-requests/:owner/:repo/:number` and renders one of four
states:

- **ready** — replace-navigate to `/runs/$runId`. One review implementation, and
  the PR URL stays a working bookmark.
- **needs-generation** — POST `/api/generate` on mount, then fall into progress.
- **generating** — a progress card naming the PR, showing `Queued — 2 ahead` or
  `Chaptering…`, polling `/api/generate/:jobId`. Navigates to the run on success;
  on failure shows the agent's error with a Retry button.
- **no-clone** — a card: "Stage needs a local clone of `owner/repo`", the exact
  `git clone` line with a copy button, the search roots it looked in, and a
  Rescan button for when you've just cloned it.

### Onboarding

With zero roots configured, browsing has nothing to show and the reason isn't
guessable. The dashboard shows a card at top — "Stage doesn't know where your
clones live" — with a folder input posting to `/api/clone-roots`. It disappears
once a root exists. `/settings` is the same UI permanently: roots with remove
buttons, an add field, and a Rescan reporting "142 repos across 6 owners".

### Hooks

In `packages/web/src/lib/`: `use-pull-requests.ts` (generalizes today's
`use-inbox.ts`, keeping its poll bail-out), `use-pr-resolution.ts` (the state
machine above, absorbing `useChapterGeneration`), `use-browse.ts`,
`use-clone-roots.ts`.

## Failure modes

Every `gh`-backed surface returns the existing `{available: false, reason}`
envelope rather than an HTTP error, so a missing or unauthenticated `gh` renders
as "Couldn't reach GitHub — you may need to run `gh auth login`" in the affected
section only.

**No local clone** is the new failure, and it's a state rather than an error: a
422 carrying `nameWithOwner`, which the UI turns into a clone command. The same
check guards `POST /api/generate`, so a hand-crafted request can't start an agent
in a directory that doesn't exist.

**Stale index** — a clone moved or deleted since startup. The registry
re-validates that the path exists at resolution time and reports no-clone
instead of letting the agent fail on a missing `cwd`; rescan is the fix.

**Scan hazards** — symlink loops, huge trees, unreadable directories. Covered by
the visited-real-path set, the depth bound, and skipping unreadable directories.

## Testing

Per TESTING.md's preference for real behavior over mocks:

- `CloneIndex` against fixture directory trees in a temp dir: nested repos, a
  linked worktree with a `.git` file, a bare clone (skipped), a non-GitHub remote
  (skipped), a repo past the depth bound, an unreadable directory, a symlink loop.
- `clone-root-store` round-trips, plus rejection of relative paths and
  non-directories.
- `pr-search` filter mapping and the malformed-row-drop behavior, with `gh`
  output as fixtures.
- Routes, on the existing `runs-route-harness.ts`: resolution returning each of
  the four states, `/api/generate` 422 when no clone is known, the `RunIndex`
  fallback path, and `queuePosition` across a two-job queue.
- Frontend: `use-pr-resolution` covering auto-generate-on-mount, queue-position
  display, and failure-then-retry — matching how `use-inbox.test.tsx` is written.

`JobManager` keeps its injected `JobRunner` seam; no test spawns a real
`claude -p`.

## Out of scope

Cloning from the UI. A closed/merged PR filter. A cross-org PR search box. A
persisted scan cache. Parallel generation. Each is additive later.
