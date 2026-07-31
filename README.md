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
| `--pr <number-or-url>` | Review a GitHub pull request by number or URL (requires `gh`) |

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
```

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
