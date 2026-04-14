# Contributing

## Getting Started

See the [README](README.md) for toolchain versions and development setup.

## Workflow

We use **trunk-based development**. `main` stays releasable at all times.

- All meaningful work happens on short-lived branches merged via PR.
- Branches should live days, not weeks.
- CI must pass before merge. Squash-merge preferred for single-concern PRs.
- Direct pushes to `main` are acceptable only for trivial fixes (typos, comment corrections).

### Branch Naming

Use a prefix that describes the type of change:

| Prefix | Use |
|---|---|
| `feat/` | New feature or capability |
| `fix/` | Bug fix |
| `refactor/` | Code restructuring without behavior change |
| `docs/` | Documentation only |
| `chore/` | Build, CI, tooling, or repo maintenance |

Examples: `feat/transcript-formatter`, `fix/cohere-segments`, `chore/ci-caching`.

### Pull Requests

1. Create a PR against `main`.
2. Fill out the PR template.
3. Wait for CI to pass (`npm run check` runs typecheck, lint, test, build, cargo fmt, clippy, cargo test).
4. Merge when green.

Keep PRs small and focused. One concern per PR.

### Commits

- Imperative mood: "add formatter" not "added formatter".
- First line under 72 characters.
- Body explains *why*, not *what* (the diff shows what).
- Reference issues with `#N` when applicable.

## Quality Gates

`npm run check` is the single quality gate. It runs:

- **TypeScript:** typecheck, lint (Biome), test (Vitest), build (esbuild)
- **Rust:** `cargo build`, `cargo fmt --check`, `cargo clippy`, `cargo test`

Do not merge with failing CI.

## Feature Flags

Incomplete work that touches `main` must be behind a gate — a settings flag, a code-level conditional, or an unexposed command. Never ship half-built user-facing behavior ungated.

## Documentation

- **User-facing behavior changes** — update [README.md](README.md).
- **Durable decisions** — record in [docs/decisions.md](docs/decisions.md) in the same PR that changes behavior.

## Architecture Overview

The plugin has two runtime boundaries:

- **TypeScript plugin** (`src/`) — Obsidian UX, settings, editor insertion, audio capture
- **Rust sidecar** (`native/sidecar/`) — inference, audio processing, model loading

See [docs/pipeline-architecture.md](docs/pipeline-architecture.md) for the transcript pipeline design.
