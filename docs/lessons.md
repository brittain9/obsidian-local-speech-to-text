# Lessons

Mistake log. If we made a real mistake worth not repeating, it goes here. One line each.

Format: `- YYYY-MM-DD | [tag] | Pattern: … | Rule: …`. Tags: `[build]`, `[test]`, `[gpu]`, `[process]`.

- 2026-04-11 | [build] | Pattern: `cargo clippy` can rerun `whisper-rs-sys` setup and fail even when build/test pass. | Rule: verify with `cargo build`/`cargo test`; run clippy with `DOCS_RS=1`; do not set `WHISPER_DONT_GENERATE_BINDINGS=1` (shipped bindings break Windows).
- 2026-04-12 | [test] | Pattern: `poll_event_returns_failed_on_channel_disconnect` flakes under parallel load (real HTTP, 10s timeout); passes in isolation. | Rule: rerun once before treating as a regression.
- 2026-04-21 | [build] | Pattern: Windows process exit code triage went wrong from a decimal reading. | Rule: convert Windows exit codes to hex before forming a crash hypothesis.
- 2026-04-21 | [build] | Pattern: release sidecars inherited runner SIMD and shipped AVX-512, crashing on non-AVX512 user CPUs. | Rule: set `GGML_NATIVE=OFF` at job/workflow scope; never assume CI CPU features match user CPUs.
- 2026-04-21 | [build] | Pattern: a step-scoped `GGML_NATIVE=OFF` fix missed `rust-cache` restore keys and reused stale AVX-512 artifacts. | Rule: include relevant prefixes (`GGML`, `WHISPER`) in cache key env vars.
- 2026-04-21 | [gpu] | Pattern: CUDA sidecars depended on host CUDA 12 runtime libraries and failed on incompatible toolkits. | Rule: bundle reviewed CUDA runtime libs in CUDA archives; set Linux rpath to `$ORIGIN`.
- 2026-04-22 | [gpu] | Pattern: auditing only the sidecar exe missed ONNX Runtime CUDA provider deps such as cuFFT and cuDNN. | Rule: audit provider DLL/SO dependency chains, not just the main binary.
- 2026-04-22 | [build] | Pattern: deleting a running CUDA sidecar directory failed on Windows because loaded DLLs kept file handles open. | Rule: stop the owning sidecar before uninstalling or overwriting its directory.
- 2026-04-24 | [gpu] | Pattern: default CUDA architecture expansion made release builds slow and noisy. | Rule: pin the supported GPU baseline with `CMAKE_CUDA_ARCHITECTURES`; bound logs with `CMAKE_CUDA_FLAGS=-t0`.
- 2026-04-27 | [build] | Pattern: feeding raw note prose to whisper's `initial_prompt` caused style-imitation hallucinations and silent token-budget truncation past 224 tokens. | Rule: shape whisper prompts as `Glossary: t1, t2, …` of distinctive terms (proper nouns, acronyms, code identifiers) sized well under 224 tokens; never pass narrative prose.
- 2026-04-19 | [process] | Pattern: editing `PLANS.md` mid-implementation just because code shifted creates churn against an approved plan. | Rule: don't update `PLANS.md` unless the user explicitly asks for a plan change.
- 2026-04-21 | [process] | Pattern: misread stacked-branch merge status when a base branch landed earlier and advanced again. | Rule: compare specific commit SHAs against `origin/main`, not whether a branch name was previously merged.
- 2026-04-25 | [process] | Pattern: architecture brainstorming jumped into structs, traits, and protocol details before the user aligned on the high-level shape. | Rule: start architecture discussions in plain language — responsibilities and state flow before code shapes.
- 2026-04-26 | [process] | Pattern: greenfield work introduced version negotiation, compat parsers, synthesized IDs, and fallback paths despite explicit no-shim direction. | Rule: replace internal contracts as coordinated changes across boundaries; do not add backwards-compatibility shims unless the user asks.
