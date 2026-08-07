<div align="center">
  <img src="https://raw.githubusercontent.com/drj613/stage-cli/main/assets/stage-mark.svg" alt="Stage" height="80">
  <h1>Stage <sub><sup>(fork)</sup></sub></h1>
  <p>A code review tool that organizes local code changes into logical chapters and points out what to review before you dive into the code.</p>
</div>

<p align="center">
  <a href="https://github.com/drj613/stage-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/drj613/stage-cli.svg" alt="license"></a>
</p>

> **This is my personal fork of [ReviewStage/stage-cli](https://github.com/ReviewStage/stage-cli).**
> I work on it here, so `main` may sit ahead of — or diverge from — upstream, and nothing here is published to npm.
> For the maintained release, see the upstream repo, the [`stagereview`](https://www.npmjs.com/package/stagereview) package, or [stagereview.app](https://stagereview.app).

## What this fork adds

This fork keeps Stage's chapter-based diff review and extends it into a local GitHub review
workspace:

- **Review on GitHub from Stage.** See existing GitHub review threads beside the diff, reply to
  and resolve them, draft line comments, then submit an approval, comment, or change request.
- **A persistent, multi-repo dashboard.** Browse pull requests in your local clones, see everything
  waiting on your review, reopen recent runs, and generate chapters on demand with live phase and
  activity progress. Small diffs open as a single chapter without spending an agent run.
- **Stacked pull requests as one review.** Stage detects PR chains, links them from the dashboard,
  accepts repeated `--pr` flags, and builds one run with a view for each member. Comment targets are
  limited to members that changed the file, and reviews are submitted one PR at a time.
- **Scriptable, repo-independent runs.** Runs share one database across repositories, while
  `stagereview import` lets headless or custom workflows add a generated run without opening the UI.

Everything still runs locally. GitHub-backed features use your authenticated `gh` CLI, and chapter
generation runs through your local Claude CLI.

## Setup

This fork isn't on npm, so run it straight from your clone. Two halves need wiring up: the `stagereview` binary and the `stage-chapters` skill.

**1. Build the CLI.** The binary is bundled output, so it has to exist before you link it.

```bash
git clone https://github.com/drj613/stage-cli.git
cd stage-cli
pnpm install
pnpm build
```

**2. Put `stagereview` on your PATH.**

```bash
cd packages/cli
npm link
```

Check it: `which stagereview && stagereview --version`.

> `pnpm link --global` works too, but only after `pnpm setup` has created a global bin directory. `npm link` needs no setup.

**3. Add the skill.** `npx skills add` only installs from GitHub, so link the skill directory yourself. Symlinking (rather than copying) means edits to `SKILL.md` take effect immediately.

```bash
# from the repo root
ln -sfn "$PWD/skills/stage-chapters" ~/.claude/skills/stage-chapters   # Claude Code
ln -sfn "$PWD/skills/stage-chapters" ~/.codex/skills/stage-chapters    # Codex
```

Swap `~/.claude` for a project's `.claude/skills/` to scope the skill to one repo instead of your whole user account.

Restart your agent and `/stage-chapters` will use your local code.

**After changing CLI source**, re-run `pnpm build` — the linked binary points at `packages/cli/dist`, which is only refreshed by a build. Changes to `skills/stage-chapters/SKILL.md` need no build, just a fresh agent session.

### Unlinking

```bash
npm unlink -g stagereview
rm ~/.claude/skills/stage-chapters ~/.codex/skills/stage-chapters
```

If you'd previously installed the upstream release, remove that too: `npx skills remove ReviewStage/stage-cli && npm uninstall -g stagereview`.

## Usage

In your AI agent, run:

```
/stage-chapters
```

This organizes your local changes into reviewable chapters and opens a browser UI. Everything happens on your machine.

### Options

| Flag | Description |
|------|-------------|
| `--base <ref>` | Base ref to diff against (default: auto-detect main/master) |
| `--compare <ref>` | Compare ref to diff against `--base` |
| `--ref <mode>` | Diff scope: `work` (staged + unstaged + untracked), `staged`, or `unstaged` (default: auto-detect) |
| `--pr <number-or-url>` | Review a GitHub pull request by number or URL; repeat for each member of a stack (requires `gh`) |

Examples:

```bash
# Review only staged changes
/stage-chapters --ref staged

# Diff against a specific branch
/stage-chapters --base feature-a

# Compare two branches
/stage-chapters main feature
/stage-chapters main..feature
/stage-chapters --base main --compare feature

# Review a teammate's PR by number or URL
/stage-chapters --pr 123
/stage-chapters --pr https://github.com/owner/repo/pull/123

# Review a stacked chain as one run (order is inferred from git ancestry)
/stage-chapters --pr 123 --pr 124 --pr 125
```

### The dashboard: `stagereview start`

```bash
stagereview start            # open the dashboard in a browser
stagereview start --no-open  # print the URL only
stagereview start --model opus  # default model for one-click generation
```

Starts a long-lived local server with a home dashboard showing:

- **Waiting on your review** — open PRs across all orgs where your review is requested (via `gh search prs`; requires `gh auth login`). Each row links to an existing chapter run, or offers one-click **Generate chapters**, which runs a headless `claude -p` session (Sonnet by default) in a local clone Stage already knows and imports the result. Generation runs sequentially, asks for confirmation first, and reports its current phase and recent activity. Small diffs skip the agent and open immediately as one chapter.
- **Recent runs** — every past chapter run, newest first, linking into the review UI.
- **Repository browsing** — organizations, repositories, pull requests, and detected PR stacks from the clone roots Stage scans. You can add and remove roots from the dashboard's settings page or with the CLI:

```bash
stagereview config add-root ~/src
stagereview config list-roots
stagereview config remove-root ~/src
```

Runs live in one global database (`~/.stage/db.sqlite`), so the dashboard sees runs from every repo no matter where you start it.

### Headless import: `stagereview import`

```bash
stagereview import chapters.json --pr 123
```

Same arguments as `show`, but inserts the run into the database and prints the new run's `runId` without starting a server or opening a browser. Used by the dashboard's headless generation; handy for any scripted flow.

### `.stageignore`

Add a `.stageignore` file to your repo root to exclude files from the diff analysis. Uses `.gitignore`-style patterns, one per line:

```
# Build artifacts
build/**
dist/**

# Generated code
*.generated.ts

# But keep this one
!dist/important.js
```

Ignored files still appear in the "Other changes" chapter so nothing is silently hidden. Comments (`#`), blank lines, and negation patterns (`!`) are supported — last matching pattern wins.

<img width="1840" height="1196" alt="Stage CLI" src="https://raw.githubusercontent.com/drj613/stage-cli/main/assets/screenshot.png" />

## Development

Common commands — see [AGENTS.md](AGENTS.md) for architecture and conventions.

```bash
pnpm dev:web      # web UI in Vite dev mode
pnpm build        # build SPA, then bundle the CLI
pnpm test         # Vitest
pnpm typecheck    # tsc --noEmit across every package
pnpm lint         # Biome (fails on warnings)
pnpm db:generate  # new Drizzle migration from schema changes
```

Run `pnpm typecheck && pnpm lint && pnpm test` before pushing.

### Staying in sync with upstream

```bash
git remote add upstream git@github.com:ReviewStage/stage-cli.git   # once
git fetch upstream
git rebase upstream/main
```

## License

[MIT](LICENSE) — same as upstream.
