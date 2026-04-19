# Contributing

## Getting Started

See the [README](README.md) for toolchain versions and development setup.

## Architecture Overview

The repository has two runtime boundaries:

- **TypeScript plugin** (`src/`) — Obsidian UX, settings, microphone capture, editor insertion, orchestration.
- **Rust sidecar** (`native/`) — inference (via a three-layer engine registry: runtime / model family adapter / loaded model), audio-domain processing (VAD, diarization), and all post-transcript enrichment (hallucination filter, punctuation, user rules, render).

Audio crosses the boundary as 16 kHz mono PCM over stdin in a framed binary protocol; transcripts come back on stdout as JSON events. The sidecar owns everything between "audio in" and "finished text out".

For the full picture — current architecture, planned post-transcript enrichment pipeline, and per-stage detail — see [docs/architecture/system-architecture.md](docs/architecture/system-architecture.md).

For repo-wide principles and the session workflow (how to use decisions, lessons, and plans), see [AGENTS.md](AGENTS.md).

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

Examples: `feat/punctuation-stage`, `fix/cohere-segments`, `chore/ci-caching`.

### Pull Requests

1. Create a PR against `main`.
2. Fill out the PR template.
3. Wait for CI to pass (`npm run check` runs typecheck, lint, test, build, cargo fmt, clippy, cargo test).
4. Merge when green.

Keep PRs small and focused. One concern per PR.

## Quality Gates

`npm run check` is the single quality gate. It runs:

- **TypeScript:** typecheck, lint (Biome), test (Vitest), build (esbuild)
- **Rust:** `cargo build`, `cargo fmt --check`, `cargo clippy`, `cargo test`

Do not merge with failing CI.

## Documentation

- **User-facing behavior changes** — update [README.md](README.md).
- **Durable decisions** — record in [docs/decisions.md](docs/decisions.md) in the same PR that changes behavior. Mark superseded decisions explicitly rather than deleting them.
- **Execution mistakes / corrections** — add a concise preventive rule to [docs/lessons.md](docs/lessons.md). Deduplicate against existing entries.
- 