# PR stacks — design

## Problem

Stage treats every pull request as an island. A run reviews exactly one PR
(`chapter_run.prNumber`), the dashboard lists PRs as a flat set, and nothing in
the UI hints that three of those rows are one feature split across a chain of
branches.

Reviewing a stack today means opening each PR separately and reading the same
context three times. The split is an artifact of how the author chose to land
the work — the reviewer has to reassemble the story by hand, and a chapter that
would naturally span two PRs can't exist.

## Goal

- Show, in both PR lists, that a PR belongs to a stack and where it sits in it.
- Let the reviewer open a chain as **one** chaptered run and step through it.
- Keep feedback routed to the PR the author will actually fix it in.

Non-goals: creating or restructuring stacks (that's `gh stack`'s job), stacks
spanning repositories or forks, stacks with merged members, and merge/reviewer/
status controls on the stack run page (see [Run page](#run-page)).

## Definitions

A **chain** is an ordered list of open PRs `[p₀ … pₙ]` in one repository where
each `pᵢ₊₁`'s base branch is `pᵢ`'s head branch, and `p₀`'s base is not any open
PR's head. The chain is identified by its **tip**, `pₙ`.

`/stack/:owner/:repo/:number` means *the chain ending at `:number`*. This is the
whole disambiguation rule: a branching stack has one chain per leaf, and each is
addressed by its own tip. There is no "the stack for PR #12" when #12 has two
children — only "the chain ending at #13" and "the chain ending at #14".

## Stack detection

New `packages/cli/src/github/stack-index.ts`.

```
gh pr list --repo <owner/name> --state open --limit 100 --json \
  number,title,url,author,isDraft,updatedAt,headRefName,baseRefName,headRepository,isCrossRepository
```

Index PRs by head branch. A PR's parent is the PR whose head branch equals this
PR's base branch. Ancestors are unambiguous — a PR has exactly one base — so
walking up always terminates at a root.

Four boundary conditions, all of which produce a *loud* or *absent* answer
rather than a confidently wrong chain:

- **Cross-repository PRs are excluded.** A fork can have a `feature` branch with
  the same name as the upstream's, so matching on branch name alone would invent
  a parent. PRs with `isCrossRepository` true are dropped from the graph.
- **Duplicate head branches** (two open PRs claiming one head) mark both PRs
  ungraphed rather than picking one.
- **Cycles** are detected during the walk with a visited set and mark the
  involved PRs ungraphed.
- **A full-cap result is incomplete, not complete.** If `gh pr list` returns
  exactly the limit, a parent or child may exist beyond it, so the response is
  marked `complete: false` and the UI shows no badges. Better nothing than a
  `2/3` that is really `2/5`.

A PR with no parent and no children is not in a stack.

Served by `GET /api/stacks/:owner/:repo`, cached with a short TTL and shared by
the dashboard's search sections and Browse. On `gh` failure it returns
`{available: false, reason}`, mirroring `PullRequestListResponse`.

### Why not gh-stack metadata

Rejected. `gh stack list --json` is authoritative but reads **local** git state —
it needs the stack checked out on this machine. Stage's primary use case is
reviewing other people's PRs, where that state doesn't exist. `gh stack submit`
writes an auto-generated footer into PR bodies, but its format is unverified,
and parsing an unverified format produces a silently wrong badge.

Base-ref chaining's one real gap is a **merged parent**: GitHub retargets the
child to `main`, so the chain reads shorter than it was. Merged PRs aren't
reviewable, so the gap is acceptable.

## Data model

`chapter_run.prNumber` — a single nullable integer — is replaced by a join
table. One representation, not two.

```
chapter_run_pull_request
  runId     text     → chapter_run.id, cascade delete
  prNumber  integer  not null
  headSha   text     not null   -- that PR's head when the run was generated
  position  integer  not null   -- 0 = bottom of the chain
  primary key (runId, prNumber)
  unique (runId, position)
```

| Run kind | Rows |
| --- | --- |
| Local (`show` with no `--pr`) | 0 |
| Single PR | 1 |
| Stack | N |

Per-member `headSha` is what makes stack staleness work.

**No attribution table.** An earlier draft persisted a file→PR map. Cut: the run
diff is already recomputed from stored SHAs on every load
(`routes/diff.ts:54`), so a member's file set is equally derivable on demand
with `git diff --name-only -z <memberBase>..<memberHead>`. One function,
`memberFilePaths(run)`, serves both the chapter PR chips and the comment target
list. Revisit only if profiling says otherwise.

### The scope key does not change

`deriveScopeKey` stays exactly as it is. It anchors comment threads and chapter
external IDs across regeneration (`runs/scope-key.ts:12-16`), so folding member
SHAs into it would *detach* comments whenever a member moved — the opposite of
its purpose. Staleness is a separate mechanism (below).

### Migration

Create the table, backfill one row per non-null `chapter_run.prNumber`
(`position` 0, `headSha` from `chapter_run.headSha`), then drop the column.
`pnpm db:generate` will not produce the backfill — the generated SQL must be
hand-edited to include it.

## Generation

The daemon's diff resolution is only a preflight. Real generation prompts a
headless agent with one `--pr` URL (`generation/agent-session.ts:65`), and the
agent finishes by calling `stagereview import ... --pr <ref>`
(`skills/stage-chapters/SKILL.md:348`). Stack membership therefore has to travel
the whole route → job → prompt → CLI → import path. This is the largest part of
the work and the earlier draft wrongly called it unchanged.

**`--pr` becomes repeatable.** `stagereview prep --pr 12 --pr 13 --pr 14` and the
same flags on `show`/`import`. A single `--pr` behaves exactly as today, so
there is one concept rather than a separate `--stack` flag, and
`SKILL.md`'s existing "use the same scope flags you passed to `prep`" needs only
a documentation line.

Order is **not** trusted from the caller. The resolver resolves every ref to a
head SHA and orders the members by ancestry, so a mis-ordered command line is
still correct.

### Diff scope

Fetch `pull/<n>/head` for every member plus the bottom PR's base branch, then
delegate to the existing seam:

```
resolveCommittedComparison(root, `origin/${bottom.baseRefName}`, tipHead)
```

`resolveCommittedComparison` computes the merge base itself (`git.ts:317-338`),
so no new diff logic is needed.

**Ancestry guard.** This union is only the whole stack when each member's head
is an ancestor of the next. After a force-push or a partial restack that stops
being true, and lower members' commits would silently vanish from the diff. So
after fetching, assert `git merge-base --is-ancestor <memberᵢ> <memberᵢ₊₁>` for
each consecutive pair and **refuse the stack loudly** if it fails, naming the
member that needs restacking. Silent omission of a member's work is exactly the
corruption CLAUDE.md ranks worse than a crash.

### Job identity

`JobRequest.prUrl` becomes `prUrls: string[]`. A tip URL alone is not an
identity: a single-PR job for #14, the chain `[12,13,14]`, and the changed chain
`[11,13,14]` all share it.

`JobManager.jobs` is already keyed by job id — the `prUrl` lookups at
`job-manager.ts:96,126,220` are linear scans. So dedupe compares the **ordered
member list** element-wise (lowercased), with no constructed key anywhere.
`evictTerminal` groups the same way; the terminal set is capped at
`MAX_RETAINED_PRS`, so the quadratic scan is trivial.

### Both insertion paths

`claude-runner.ts` has a synthetic no-agent path for diffs too small to chapter
(`claude-runner.ts:70`) alongside the agent path. Both must insert identical
membership rows, in the same transaction as the run.

## Staleness

Staleness is the resolve route comparing a stored head to the live one
(`routes/pull-requests.ts:85-101`) — not the scope key. For a stack, compare
**every** member's stored `headSha` against its live head; any mismatch is
stale. A push to a lower member does not move the tip, so checking only the tip
would miss it.

`PrResolution`'s `STALE` variant carries a single `headSha` today. The stack
resolver needs a variant that names which members moved.

## API surface

| Route | Change |
| --- | --- |
| `GET /api/stacks/:owner/:repo` | New. The chain graph plus `complete`. |
| `GET /api/stacks/:owner/:repo/:number/resolve` | New. Resolve-or-generate the chain ending at `:number`; same state machine as the PR resolver. |
| `POST /api/generate` | `prUrl: string` → `prUrls: string[]` (min 1). |
| `GET /api/runs/:runId` | Gains `pullRequests[]` (number, headSha, position). |
| `GET /api/runs/:runId/pull-request` | Single-PR runs only. Stack runs use the list below. |
| `GET /api/runs/:runId/pull-requests` | New. One entry per member. |
| `GET /api/runs/:runId/github-threads` | Fetches per member and tags each thread with its PR — N `gh` calls for a stack. |
| `POST /api/runs/:runId/github-threads/:commentId/replies` | Routes by the **thread's** PR, not the run's. |
| `POST /api/runs/:runId/review` | Becomes `POST /api/runs/:runId/reviews/:prNumber`. |

**The generate request body gets a shared Zod schema in `@stagereview/types`,
consumed by both the route and the web caller.** `use-pr-resolution.ts:41` posts
an inline object literal today, so a body change is a runtime 400 that
TypeScript cannot catch. A shared schema makes it a compile error.

### Review submission is explicitly per PR

Today submission reads the run's single PR, filters pending threads to it, and
makes one call with `commit_id: run.headSha` (`github-threads.ts:79-97`). For a
stack, `run.headSha` is the tip and is not in a lower member's PR, so GitHub
would 422 the whole review.

Rather than pretend N GitHub mutations are atomic, the route submits **one PR at
a time**: `POST /api/runs/:runId/reviews/:prNumber`, using that member's
`headSha` from the join table as `commit_id`. The UI drives one request per PR
that has pending threads and reports per-PR results. Pending rows are deleted
only for a PR whose submit succeeded, which preserves today's
"nothing is lost on failure" behavior (`github-threads.ts:99-112`).

### Comment creation

`comment_thread.prNumber` already exists (`db/schema/comment-thread.ts:24`), but
it is populated from the run (`routes/comments.ts:57`) and the request schema
cannot carry a target (`types/comments.ts:38`). Both change: the create body
gains `prNumber`, validated against run membership, and the thread-visibility
filter at `comments.ts:245-247` becomes an `inArray` over members.

## UI

**`stack-badge.tsx`** — a lucide `Layers` icon plus `2/3`, on every stacked row
in both list surfaces. The hover card lists the chain with the current PR marked
and links to `/stack/:owner/:repo/:tip`. When the current PR sits below a fork
there is one link per reachable leaf, named by its tip — consistent with the
tip-identified definition above.

**Row markup.** The PR row is currently one `<Link>` wrapping everything
(`pull-request-list.tsx:85-109`), so a hover-card button inside it would be a
button nested in an anchor — invalid, and broken for keyboard users. The row
becomes a relative container with a stretched-link anchor on the title and the
badge as a sibling above it.

**`use-stacks.ts`** — fetches once per distinct repo *after* the rows render, so
a slow `gh` call never delays the list; badges appear a beat later. This is also
why badges sit on rows rather than collapsing them into group headers: the
dashboard's search sections may hold only part of a chain, and a group row would
present that partial view as the whole stack.

**PR page** — a stack section in the overview sidebar: the chain, current
marked, same links.

<a id="run-page"></a>**Stack run page** — the existing run page, with PR-specific
chrome cut. The layout today renders one PR's header, merge state, reviewers,
status mutations, and review toolbar (`pull-request-layout.tsx:117,235`); none of
those have a single meaning for a chain. A stack run shows a chain header
(`stack #12→#14`), per-chapter PR chips, and the review toolbar in its per-PR
form. Merge/reviewer/status controls stay on the individual PR pages.

The comment composer gains a target-PR select. Options come from
`memberFilePaths` — the members whose own diff touches this file — and when
there is exactly one it is preselected.

**Runs list** — a stack run shows its range instead of a single `#13` badge.

## Error handling

| Situation | Behavior |
| --- | --- |
| `gh` fails for `/api/stacks` | No badges, nothing surfaced. A badge is an enhancement, not the content. |
| `gh pr list` returns exactly the cap | `complete: false`, no badges. |
| A member is not an ancestor of the next | Generation refuses, naming the member to restack. |
| Any member's live head moved | `STALE`, naming the moved members. |
| A review submit fails for one member | That member's pending threads survive; other members' results stand. |

### Known limitation: line drift

Thread coordinates are captured in the union diff's tip-head coordinates but
posted against a member's head. If a higher member shifted the file, a comment
can land on the **wrong line** rather than failing — silent, not loud. Restricting
target options to members whose own diff touches the file (via `memberFilePaths`)
narrows this substantially but does not eliminate it. Accepted for v1 and stated
here rather than discovered later; the fix, if it bites, is to translate line
positions through each member's diff before posting.

### Known limitation: renames

A file renamed mid-stack is attributed under its pre-rename path for lower
members, so a chip can miss a PR that did touch the file under its old name.

## Testing

Per `TESTING.md`, weighted toward route-level integration.

**Unit — `StackIndex`.** Pure function over fixture `gh pr list` JSON: linear
chain, fork (one chain per leaf), orphan, merged-parent gap, cross-repository
exclusion, duplicate head branches, cycle, and exact-cap incompleteness.

**Integration — union diff.** A temp git repo with three real stacked branches,
asserting the union diff equals the whole stack, plus a non-ancestor case
asserting generation refuses.

**Route.** `/api/stacks/:owner/:repo` shapes and the unavailable branch;
`/api/generate` with `prUrls` of length 1 and N, including the shared-schema
contract the web caller uses; per-PR comment creation with a `prNumber` outside
membership rejected; per-PR review submission including partial failure leaving
the failed member's threads intact; multi-PR runs through the run routes;
membership cascade on run delete. All against real SQLite.

**Unit — job identity.** A single-PR job for the tip and a stack job containing
it do not dedupe against each other.

**Migration.** A run with a `prNumber` backfills to exactly one join row; a local
run to zero. A wrong backfill silently detaches every existing run from its PR.

**Web.** Chain math in `packages/web/src/lib/` as a pure function. Static badge
rendering stays untested, per policy.

## Follow-ups

- gh-stack body-footer parsing, specced against a real gh-stack PR body.
- Line-position translation through member diffs, if wrong-line comments bite.
- Persisted file attribution, if deriving it per load shows up in profiling.
