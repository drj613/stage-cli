<div align="center">
  <img src="https://raw.githubusercontent.com/drj613/stage-cli/main/assets/stage-mark.svg" alt="Stage" height="80">
  <h1>Stage <sub><sup>(fork)</sup></sub></h1>
  <p>A local GitHub review dashboard that organizes pull requests into logical, reviewable chapters.</p>
</div>

<p align="center">
  <a href="https://github.com/drj613/stage-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/drj613/stage-cli.svg" alt="license"></a>
</p>

> **This is my personal fork of [ReviewStage/stage-cli](https://github.com/ReviewStage/stage-cli).**
> I work on it here, so `main` may sit ahead of — or diverge from — upstream, and nothing here is published to npm.
> For the maintained release, see the upstream repo, the [`stagereview`](https://www.npmjs.com/package/stagereview) package, or [stagereview.app](https://stagereview.app).

## What this fork adds

Upstream Stage opens a chaptered view of one diff at a time. This fork turns that reviewer into a
persistent local workspace:

- **One review queue across repositories.** See pull requests waiting on you, browse PRs from your
  local clones, and reopen recent chapter runs from one dashboard.
- **Chaptering from the browser.** Click **Generate chapters** on a PR and follow the agent's live
  phase and activity. Small diffs open immediately as one chapter without spending an agent run.
- **GitHub-native review actions.** Read existing GitHub threads beside the diff, reply to and
  resolve them, draft line comments, then approve, comment, or request changes without switching
  tools.
- **Stack-wide reviews.** Stage detects PR chains and opens the stack as one run with a view for
  each member. Comment targets are limited to members that changed the file, and reviews are
  submitted one PR at a time.

Everything still runs locally. GitHub-backed features use your authenticated `gh` CLI, and chapter
generation runs through your local Claude CLI.

## Run it locally

This fork is not published to npm. Build it from the clone and link the dashboard CLI:

```bash
git clone https://github.com/drj613/stage-cli.git
cd stage-cli
pnpm install
pnpm build
cd packages/cli
npm link
```

You will also need the [GitHub CLI](https://cli.github.com/) and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated:

```bash
gh auth login
claude --version
```

Start the dashboard from anywhere:

```bash
stagereview start
```

On first run, open **Settings** and add a directory that contains your local clones. Stage scans
those roots to connect GitHub pull requests with the repositories where chapter generation runs.
You can manage the same setting from the terminal:

```bash
stagereview config add-root ~/src
stagereview config list-roots
stagereview config remove-root ~/src
```

Return to the dashboard, choose a pull request from your review queue or repository browser, and
click **Generate chapters**. Stage prepares the diff, runs chapter generation when the change is
large enough to benefit from it, imports the result, and opens the review—all from that one flow.

The server stays attached to the terminal until you press Ctrl+C. Runs live in one global database
at `~/.stage/db.sqlite`, so the same dashboard sees every configured repository regardless of where
you start it.

### Dashboard options

```bash
stagereview start --no-open     # print the URL without opening a browser
stagereview start --model opus  # choose the default generation model
```

### Unlinking

```bash
npm unlink -g stagereview
```

## Automation

The dashboard uses `stagereview import` to save a generated chapters file without opening another
server or browser. Custom workflows can use the same handoff:

```bash
stagereview import chapters.json --pr 123
```

The command validates and inserts the run, then prints its `runId`.

## Ignoring files during chaptering

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

Ignored files still appear in the "Other changes" chapter so nothing is silently hidden. Comments
(`#`), blank lines, and negation patterns (`!`) are supported — last matching pattern wins.

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
