# Small-PR diff view + cwd-independent generation

**Goal:** Stop losing generation runs to working-directory drift, and skip chapter generation entirely for PRs too small to need it — producing a normal run with one synthetic chapter instead.

**Origin:** A real dependabot PR (`EnovisHCS/motion1#28`, `Gemfile.lock` only, 48+/48−) failed generation with `Agent did not return a valid runId.` Diagnosis below.

---

## What actually happened (evidence, not inference)

| Finding | Evidence |
| --- | --- |
| The PR is open, not merged | `gh pr view 28 --json state` → `OPEN`, `mergedAt: null` |
| It has a real diff | `changedFiles: 1`, `additions: 48`, `deletions: 48` |
| Prep produced **zero** hunks | `stage-prep-1785969281842.txt` is 157 bytes, `=== HUNKS ===` empty — `filterFilesForLlm` excludes lockfiles |
| The agent's output was **valid** | `AgentOutputSchema.safeParse` → success (verified) |
| The import **works** | Run manually from the clone: succeeds both arg orders (`aefb4d01…`, `d626bf8c…`) |
| So the failure was environmental | ✔ |

**Root cause: `stagereview import` ran outside the clone.** The daemon spawns the agent with `cwd: job.repoRoot` (`agent-session.ts:83`), so the agent *starts* in the right place. The shell cwd then **persisted across Bash calls**: an early `cd` moved it elsewhere (those steps render as opaque `Shell command`, because `cd` is not on the display allowlist), and the final bare `stagereview import --pr …` inherited the stray directory. `runImport` → `readRepoContext()` → `process.cwd()` then hit the same-repo rejection at `pull-request-ref.ts:71`.

Note the earlier "each Bash call is a fresh shell" reading was wrong, and the distinction matters: under that reading the import would have started in `repoRoot` and succeeded. The remedy below is robust under either mechanism.

**Three consequences, all worth fixing:**
1. **The agent path is unprotected** — nothing tells the agent to run `stagereview` from the repo root. This is what actually broke, and it breaks large PRs too, which the size threshold cannot rescue.
2. The prep/import pipeline is `process.cwd()`-dependent (14 `execFileSync` calls in `git.ts` omit `cwd`), so the *daemon* cannot resolve a scope in-process at all. This blocks the feature rather than causing the outage.
3. A lockfile-only PR yields zero *filtered* hunks, so the agent has nothing to cluster. It should never have been spawned.

---

## Scope

**In:** cwd-independence; a size threshold that skips generation; a synthetic single-chapter run; a diagnosability fix.
**Out:** run-status/DB migration; a distinct "diff-only" run type; changes to the wire API or SPA data flow; the merged-PR empty-diff case (not what bit us).

---

## Architecture

Dispatch inside the existing `JobRunner`, not at the route. `JobManager` already takes a runner (`job-manager.ts`), and `claudeRunner` is one implementation. The runner resolves the diff scope in-process; if the filtered diff is under threshold it builds a synthetic `ChaptersFile` and calls `insertChaptersFile` directly, returning the runId; otherwise it spawns `AgentSession` exactly as today.

**Zero API change, zero SPA change.** The queue, retention, progress snapshots, polling, and row badges all work unmodified because the job still resolves to a runId.

---

## Task 1: Report the schema error the agent can act on

`build-chapters-file.ts:48` throws the `ChaptersFileSchema` error when a payload fails *both* schemas. The agent is asked to produce `AgentOutputSchema`, so it gets told about fields (`scope`, `generatedAt`) it was never meant to emit.

- [ ] Report the `AgentOutputSchema` failure (or both, clearly labelled).
- [ ] Test: an output with a malformed `prologue.complexity` reports a `prologue` issue, not `scope: Required`.
- [ ] Commit: `fix: report the schema the agent was asked to produce`

## Task 2: Harden the agent prompt against a stray working directory

**This is the fix for the actual outage.** Independent of Tasks 3-7; ship it early.

- [ ] `promptFor()` (`agent-session.ts:59`) interpolates the absolute `job.repoRoot` and instructs: run every `stagereview` command from that root, prefix each with `cd <repoRoot> && `, and never assume a `cd` from an earlier command persists.
- [ ] `skills/stage-chapters/SKILL.md` headless section: same instruction, so interactive runs match.
- [ ] Same file, Step 3: if `=== HUNKS ===` is empty, emit an empty `chapters` array — do not invent hunkRefs.
- [ ] Test: the built prompt contains the job's repoRoot.
- [ ] Commit: `fix: run stagereview from the repo root in headless generation`

## Task 3: Thread an explicit repo root through the git layer

Not the outage fix — the prerequisite for the daemon resolving a scope in-process. `process.chdir()` is not an option: the server concurrently serves routes that read `process.cwd()`.

Mechanical, with precedent — `routes/diff.ts` already threads `cwd: repoRoot`, and `readOriginUrl` uses `git -C <root>`. Pick one style, be uniform, thread a single `repoRoot: string` rather than sprinkling optionals.

- [ ] All 14 `execFileSync` calls in `packages/cli/src/git.ts` — including **`detectBaseRef`** and **`getUntrackedDiff`**, which the plan previously missed and which the repo-A/repo-B test hits on the default single-ref path.
- [ ] Propagate through `ResolveScopeOptions` / `DiffScopeOptions` / `runPrep` / `runImport` / `readRepoContext`.
- [ ] Thread the `readRepoRoot()` call sites too: `prep.ts:21` and `build-chapters-file.ts:57` (`loadStageIgnore(readRepoRoot())`).
- [ ] Default to `process.cwd()` at the CLI entry points so `prep` / `show` / `import` behaviour is unchanged.
- [ ] Test: resolve a scope for repo A while the process sits in repo B (two temp git repos, init + one commit each).
- [ ] Commit: `refactor: resolve git scope against an explicit repo root`

## Task 4: Extract shared diff resolution

So the daemon's view of "what counts" cannot drift from the agent's.

- [ ] One function returning `{ scope, rawDiff, mergeBaseSha, files, excludedByPath, stats }` from `resolveDiffScope` + `parseGitDiff` + `filterFilesForLlm`. Prep needs `mergeBaseSha` for commit messages; the daemon needs `rawDiff` for `buildOtherChangesChapter`'s `allFiles`.
- [ ] `runPrep` consumes it — verify prep output is byte-identical for a fixture (a temporary assertion in a test, not a permanent snapshot).
- [ ] Commit: `refactor: share diff resolution between prep and the daemon`

## Task 5: `shouldGenerateChapters`

- [ ] Pure function over the filtered stats, named constants, no magic numbers.
- [ ] **Rule:** skip when `filteredHunkCount === 0`; also skip when `filteredHunkCount <= 3 && filteredFileCount <= 2 && changedLines <= 40`.
- [ ] Tests: zero hunks; one hunk; each boundary exactly at and one over.
- [ ] Commit: `feat: decide when a diff is too small to chapter`

## Task 6: Synthetic chapters file

- [ ] `buildSyntheticChaptersFile` — main chapter `order: 1`, title `"All changes"`, summary `"This change is small enough to review directly, so chapter generation was skipped."`, `keyChanges: []`, no prologue. `hunkRefs` generated mechanically over every filtered hunk exactly as `build-other-changes.ts:15-20` does.
- [ ] **Emit the main chapter only when filtered hunks > 0.** A lockfile-only PR gets just the "Other changes" chapter; zero filtered + zero excluded yields zero chapters, which Task 7's empty state handles. (This also makes the out-of-scope merged-PR case degrade gracefully.)
- [ ] Reuse `buildOtherChangesChapter` for `excludedByPath` files.
- [ ] Coverage is by construction, not by calling `validateHunkCoverage` — that function is private to `build-chapters-file.ts` and never runs on this path. Pin it with a test instead.
- [ ] Test: a fixture diff round-trips through `insertChaptersFile` against a real temp SQLite and reads back with every filtered hunk referenced.
- [ ] Commit: `feat: build a single-chapter run for a small diff`

## Task 7: Dispatch in the runner

- [ ] `claudeRunner` becomes a dispatcher: resolve scope → `shouldGenerateChapters` → synthetic path or `AgentSession`.
- [ ] Use `job.repoRoot` for **both** the scope resolution and the `RepoContext` passed to `insertChaptersFile` — otherwise the run row records the daemon's cwd and every later diff/file-content route breaks for that run.
- [ ] Emit at least one schema-valid `JobProgress` snapshot (`endedAt: null`, `resolvedModel: null`, `turns: 0`, one activity entry) so the dashboard doesn't show a job jumping queued → done with no activity. **Do not set `endedAt`** — `JobManager.recordEnd` owns that stamp, and it only stamps when `progress !== null`, which is why the snapshot is required.
- [ ] Errors on the synthetic path settle the job as `failed` with a real message, same as the agent path.
- [ ] Tests: a small diff produces a runId without spawning (inject at the `JobRunner` seam); a large one still spawns.
- [ ] Commit: `feat: skip the agent for diffs too small to chapter`

## Task 8: Empty states

- [ ] `chapters-index-page.tsx:168` renders `ListEmpty` (from `components/dashboard/list-notice.tsx`) rather than `null`, so a zero-chapter run isn't a page containing one word. Copy: `"No chapters in this run."`
- [ ] Commit: `fix: give a run with no chapters an empty state`

## Task 9: Verification

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- [ ] Re-run generation for `EnovisHCS/motion1#28` end to end and confirm it produces a run without spawning an agent.
- [ ] Confirm a normal-sized PR still generates chapters as before.

---

## Decisions already made (do not re-litigate)

- Threshold measured at prep, agent skipped entirely, result is a normal run with one synthetic chapter (user's explicit choices).
- Dispatch in the runner, not the route.
- No DB migration; a synthetic run is deliberately indistinguishable from an agent run at the schema level.
- Not fixing the merged-PR empty-diff case — not what bit us here.

## Known risks

- `--pr` scope resolution costs `gh pr view` + `git fetch` on every generate request, including ones that go on to spawn the agent. Acceptable: the same fetch is needed to build the run, and the agent would do it anyway.
- Threshold values are reasoned, not measured — no telemetry exists. Named constants, easy to tune.
- Single-chapter UX has friction (an index page listing one item). Out of scope; note it.
