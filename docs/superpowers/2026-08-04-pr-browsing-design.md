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
| On-demand chaptering | Generates immediately on click, no confirmation dialog — but only on the first attempt per PR per server session. |
| Failed generation | Surfaced as its own state with an explicit Retry. Never auto-retried. |
| Moved PR head | Detected by comparing the run's `headSha` to the live head; the page offers Regenerate next to the existing review. |
| Concurrency | Stays serialized; queue position is shown. |
| Persisted state | Search roots in SQLite. The scan result is in-memory only. |
| Name keys | Every `nameWithOwner` key is lowercased, matching `toNameWithOwner`. |
| Remotes | `origin` only. Fork-based clones are a known limitation. |

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

Keys are lowercased `owner/repo` produced by the existing `toNameWithOwner`, so
they match `RunIndex`'s keys and `gh`'s canonical casing without per-call
normalization at each comparison site. `owners()` merges case variants.

Built by walking each root breadth-first to a bounded depth (default 4),
stopping descent at any directory that is itself a repo, and skipping
`node_modules` and dot-directories. For each hit it reads `.git/config` directly
and parses the `origin` url — no `git` subprocess per repo, so hundreds of clones
scan in well under a second.

The parse is deliberately capped: a literal `url =` inside a `[remote "origin"]`
section, quoted or bare. Repos whose origin url arrives via `include.path` or
`includeIf` are skipped rather than half-understood — the fallback is the
`RunIndex` path or an explicit root, and pulling in a full INI parser to chase a
rare config shape isn't worth the dependency. A `.git` *file* (linked worktree)
is resolved by reading its `gitdir:` pointer and then that directory's
`commondir` file, which is where the real config lives; resolving `gitdir`
alone lands in `.git/worktrees/<name>`, which has no `config`. Bare clones and
non-GitHub remotes are skipped.

Only `origin` is indexed. A clone whose `origin` is a personal fork will not
register for the upstream repo, so upstream PRs report no-clone. That is
intentional: `resolvePullRequestRefs` fetches `pull/N/head` from `origin`, which
doesn't exist on a fork remote, so indexing other remotes would produce clones
that pass the check and then fail to fetch. Fork-based workflows are out of
scope; the no-clone card is the honest answer for them.

The walk tracks visited real paths so a symlink loop terminates, and skips
unreadable directories rather than aborting — a permissions error on one folder
must not kill the scan.

**`clone-registry.ts`** — owns the roots store and the current index, exposes
`rescan()` and `resolveRepoRoot(nameWithOwner)`. One instance per server
process, built at startup, injected into the routes that need it.

`resolveRepoRoot` is the **single** path-resolution entry point, used by both
resolution and `POST /api/generate`. It tries the clone index, falls back to
`RunIndex.repoRootFor`, and — whichever source answered — confirms the directory
still contains a `.git` entry before returning it. Validating one source and
trusting the other is how a moved clone turns into a raw ENOENT inside a spawned
agent instead of a no-clone state.

Rescans are serialized: a request arriving while a scan is in flight awaits that
scan rather than starting a second one, so two tabs can't race and let an older
result win the swap.

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
| `GET /api/pull-requests/:owner/:repo/:number` | Resolution state — see below. Always 200 when the request is well-formed; the states are peers, not errors. |
| `GET/POST/DELETE /api/clone-roots` | Root management. Writes go through the existing `enforceSameOrigin` guard. |
| `POST /api/clone-roots/rescan` | Rebuilds the index, returns repo and owner counts. |
| `POST /api/generate` | Contract unchanged, including its existing **422** when no clone is known. Resolves `repoRoot` through `CloneRegistry.resolveRepoRoot`. |
| `GET /api/generate/:jobId` | `GenerationJob` gains `queuePosition`: `null` when running or terminal, otherwise 1-based. |

#### Resolution states

`GET /api/pull-requests/:owner/:repo/:number` returns 200 with a discriminated
union on `state`, drawn from a `PR_RESOLUTION` const object:

| `state` | Payload | Meaning |
|---|---|---|
| `ready` | `runId` | A run exists and its `headSha` matches the live PR head. |
| `stale` | `runId`, `headSha` | A run exists but the PR head has moved since. |
| `generating` | `jobId` | A queued or running job for this PR (`activeJobFor`). |
| `failed` | `jobId`, `error` | The most recent job for this PR ended in failure. |
| `needs-generation` | — | No run, no job, clone available. |
| `no-clone` | `nameWithOwner` | No usable clone on disk. |

`no-clone` is a 200 state here, **not** a 422. The 422 belongs to
`POST /api/generate`, where it already lives. This matters concretely: the web
client's `jsonFetch` throws on any non-2xx with a generic `"GET … failed: 422"`,
so a 422 would reach the UI as an opaque error and the `nameWithOwner` needed to
render the clone command would be lost.

Distinguishing `ready` from `stale` costs one `gh pr view <n> --json headRefOid`
per resolution, compared against the run's stored `headSha`. Without it the
stable PR URL would permanently mean "that first run", and re-reviewing a PR
after the author pushes fixes — the primary use case — would be impossible from
the dashboard. The UI says "new commits since this review" without a count;
counting would require fetching the new objects into the clone first, which is
work the page doesn't need to do.

`failed` exists because `JobManager.activeJobFor` deliberately skips terminal
jobs, so a PR whose generation failed reports as if it had never been attempted.
Combined with auto-POST that produces one spent agent session per page refresh on
any deterministic failure (bad auth, misconfigured `claude`, agent printing no
runId). `JobManager` grows `latestJobFor(prUrl)` — the jobs map already retains
terminal jobs — and the resolver reports `failed` instead.

The resolution endpoint has no side effects. Generating on click is client
behavior: the PR page reads state and, on `needs-generation` only, POSTs
`/api/generate`. Keeping GET safe means a prefetch or a refresh can't spend an
agent session. The auto-POST is safe against double-mount and multi-tab races
because `activeJobFor` already dedupes on the canonical PR URL — that dedupe is
load-bearing for this design, not incidental.

Generation stays serialized. `JobManager` grows `positionOf(id)` reading its
existing queue array; `drain()` shifts the running job off the queue before
running it, so `indexOf + 1` is correct and `null` for running jobs falls out.
The new field has to be threaded through `GenerationJobSchema` in
`packages/types/src/generation.ts` (the frontend parses it) and through the GET
handler's explicit destructure in `generate.ts`.

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
appears once, in the higher section. Because the three fetches are independent,
a lower section dedupes only against higher sections that have *already resolved
successfully* — if a higher section is still loading, a row may render and then
disappear when the higher query lands, and if a higher section errored its rows
suppress nothing. The reflow is the accepted cost of independent failure
domains; the alternative is one endpoint that fetches all three server-side and
loses per-section degradation.

Empty sections collapse to a single muted line instead of a full empty-state
card, so four quiet sections don't dominate the page.

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

Reads `GET /api/pull-requests/:owner/:repo/:number` and renders one state per
`PR_RESOLUTION` value:

- **ready** — replace-navigate to `/runs/$runId`. One review implementation, and
  the PR URL stays a working bookmark.
- **stale** — a card offering both doors: "This pull request has new commits since
  the review was written" with **Regenerate** (POSTs `/api/generate`) and **Open
  the existing review** (navigates to the run). Never auto-regenerates — spending
  a session on revisit isn't a decision the page should make for you.
- **needs-generation** — POST `/api/generate` on mount, then fall into progress.
- **generating** — a progress card naming the PR, showing `Queued — 2 ahead` or
  `Chaptering…`, polling `/api/generate/:jobId`. Navigates to the run on success.
- **failed** — the agent's error message and a **Retry** button. No auto-POST, so
  a refresh costs nothing.
- **no-clone** — a card: "Stage needs a local clone of `owner/repo`", the exact
  `git clone` line with a copy button, the search roots it looked in, and a
  Rescan button for when you've just cloned it.

### Onboarding

With zero roots configured, browsing has nothing to show and the reason isn't
guessable. The dashboard shows a card at top — "Stage doesn't know where your
clones live" — with a folder input posting to `/api/clone-roots`.

It appears only when there are zero roots **and** at least one listed PR is
uncloned, plus in place of the empty `/browse` list. Someone upgrading with
existing runs already has a working dashboard through the `RunIndex` fallback;
nagging them about a feature they haven't reached for is noise.

`/settings` is the same UI permanently: roots with remove buttons, an add field,
and a Rescan reporting "142 repos across 6 owners".

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

**No local clone** is the new failure, and on the resolution endpoint it's a
200 state carrying `nameWithOwner`, which the UI turns into a clone command.
`POST /api/generate` keeps its existing 422 for the same condition, so a
hand-crafted request can't start an agent in a directory that doesn't exist.

**Failed generation** is a first-class state rather than an absence, so a
deterministic failure costs one session instead of one per refresh. See
"Resolution states".

**Stale index** — a clone moved or deleted since startup.
`CloneRegistry.resolveRepoRoot` re-validates that the directory still holds a
`.git` entry for *both* the index and the `RunIndex` fallback, and reports
no-clone instead of letting the agent fail on a missing `cwd`. Rescan is the fix.

**Concurrent rescans** — serialized in the registry; a second request awaits the
in-flight scan instead of racing it.

**Scan hazards** — symlink loops, huge trees, unreadable directories. Covered by
the visited-real-path set, the depth bound, and skipping unreadable directories.

## Testing

Per TESTING.md's preference for real behavior over mocks:

- `CloneIndex` against fixture directory trees in a temp dir: nested repos, a
  linked worktree whose `.git` file requires the `gitdir` → `commondir` hop, a
  bare clone (skipped), a non-GitHub remote (skipped), an origin url reachable
  only through an `include.path` (skipped), mixed-case remote urls mapping to the
  same lowercased key, a repo past the depth bound, an unreadable directory, and
  a symlink loop.
- `clone-root-store` round-trips, plus rejection of relative paths and
  non-directories.
- `CloneRegistry.resolveRepoRoot`: index hit, `RunIndex` fallback hit, and — for
  both sources — a recorded path whose directory has since been removed
  resolving to no-clone.
- `pr-search` filter mapping and the malformed-row-drop behavior, exercised at
  the pure `mapSearchResults` layer with `gh` output as fixtures (`gh()` in
  `exec.ts` has no injection seam, so tests stay above it or stub at the route
  harness boundary).
- Routes, on the existing `runs-route-harness.ts`: resolution returning each of
  the six states — including `stale` when the stored `headSha` differs from the
  live head and `failed` after a job ends in failure — `/api/generate` 422 when no
  clone is known, and `queuePosition` across a two-job queue.
- Frontend: `use-pr-resolution` covering auto-generate-on-mount for
  `needs-generation` only, the absence of auto-POST in `failed` and `stale`,
  queue-position display, and failure-then-retry — matching how
  `use-inbox.test.tsx` is written.

`JobManager` keeps its injected `JobRunner` seam; no test spawns a real
`claude -p`.

## Out of scope

Cloning from the UI. A closed/merged PR filter. A cross-org PR search box. A
persisted scan cache. Parallel generation. Fork-based clones, where `origin`
points at a personal fork rather than the upstream repo. Each is additive later.
