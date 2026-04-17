# Code Review — commit `edadfbe`

Scope: `refactor: three-layer engine registry (runtime/family/model)`.
Mindset: principal engineer + principal QA. Correctness, maintainability,
test quality, dead code, legacy shims. Findings ordered by severity.

Signal sources: targeted reads of the commit diff + surrounding modules,
`cargo check --all-features --tests`, `cargo clippy -W pedantic`,
`tsc --noEmit`, `biome check`, LSP `findReferences` on new exports.

---

## Medium

### M1 — Cohere adapter `probe_model` does not load an ONNX session

`native/src/adapters/cohere_transcribe.rs:83-95` only checks file presence:
`validate_model_path(path)`, `find_decoder_path`, `find_tokens_path`.
Compare with `native/src/adapters/whisper.rs:53-57`, which constructs
`WhisperContext` via `load_whisper_context` and therefore detects corrupt
weights at install time. A corrupt ONNX file — or a truncated tokenizer —
passes Cohere's probe and only fails at first transcription.

Fix: do a cheap `build_session` on the encoder during probe. That matches
Whisper's contract and gives the install pipeline its intended guarantee.

### M2 — `merged_capabilities_with_unknown_family` is dead production code

`native/src/engine/registry.rs:100-113` claims in its docstring to cover
"external-file selections whose family cannot be verified." The only
callers are the unit test at `registry.rs:331` and the smoke test at
`registry_smoke.rs:117`. Production code doesn't hit it:

- `app.rs:508` `build_installed_model_capabilities` uses
  `merged_capabilities`, not the unknown-family variant.
- `app.rs:934` `SelectedModel::ExternalFile` branch never calls any
  capability merge.

Two clean resolutions: wire the external-file path through this method so
the plugin can gate UI for external files too, or delete the method and
both tests. Today they exist solely to test code nothing else calls.

### M3 — `installedModelCapabilities` wire data has no consumer

`src/models/model-install-manager.ts:40,161,204,250,500` — the field is
initialized, assigned from `systemInfo.installedModels`, exposed via
`getState()`, and never read externally. Same pattern holds for the
parsed fields `supportedModelFormats`, `producesPunctuation`, and
`supportedLanguages` in `src/sidecar/protocol.ts:810-854`: parsed off
the wire and never consumed.

D-008 promises "UI driven directly from capability structs." Either the
capability-gated UI work is next (file an issue to track it) or defer
these fields until there's a caller. Right now the data flows end-to-end
with no reader.

### M4 — Catalog language tags contradict adapter capability

`native/catalog.json` advertises 14 `languageTags` per Cohere model, but
`CohereTranscribeAdapter::new` declares
`supported_languages: LanguageSupport::EnglishOnly` and
`build_prompt_tokens` hardcodes `TOKEN_LANG_EN`. `app.rs:resolve_runtime_model_path`
rejects non-`en` upstream, so no live correctness bug — but it is
misleading metadata that will mislead the language-selection UI work
when it lands. Trim tags to `["en"]` or document the gap explicitly in
`docs/decisions.md`.

### M5 — Installed models silently vanish when their runtime isn't compiled

`native/src/app.rs:492-518` `build_installed_model_capabilities` filters
out every installed model whose runtime is not in the current build. If
a user rebuilds without `engine-cohere-transcribe`, previously installed
Cohere models just disappear from `installedModels` with no explanation.

Prefer surfacing an `unavailable_reason: "runtime not compiled"` entry so
the UI can tell the user *why* their model is gone.

---

## Low

### L1 — Unreachable `Ready` match arm

`native/src/app.rs:807` is structurally unreachable: the `match status`
sits inside an error branch so `ModelProbeStatus::Ready` cannot occur.
Clippy's `match_same_arms` lint flags this independently. Collapse the
arm or restructure.

### L2 — `_type_exports` smell

`native/src/app.rs:1096-1097` defines a throwaway
`fn _type_exports(_: EngineCapabilities, _: RequestWarning) {}` just to
silence unused-import warnings. `#[allow(unused_imports)]` on the `use`
is the idiomatic fix.

### L3 — `ModelCatalog` cloned per install

`native/src/installer.rs:39` and `native/src/app.rs:293` —
`InstallRequest.catalog: ModelCatalog` is cloned by value on every
install. `Arc<ModelCatalog>` avoids copying every model entry on each
install. Minor.

### L4 — Mixed-mode imports in `model-install-manager.ts`

`src/models/model-install-manager.ts:12-21` (Biome
`lint/style/useImportType`) — after the `isEngineId` runtime import was
removed, every symbol in this block is type-only. Switch to
`import type { ... }` so the import shape stops lying.

### L5 — Redundant closures in registry iterators

`native/src/engine/registry.rs:53,57,61,71,84` — five Clippy hits
(redundant closures, `map().unwrap_or_else()` patterns) concentrated in
the registry's public iterator API. Small but worth fixing because this
is a core module that other contributors will model future additions on.

### L6 — Pedantic cast hygiene in new Cohere adapter

`native/src/adapters/cohere_transcribe.rs` — roughly fifteen clippy
warnings for `casting i64 → u32/usize` plus `too many lines (104/100)`
on `autoregressive_decode`. The casts sit at ONNX tensor-index
boundaries and are likely fine in practice, but leaving pedantic
warnings unaddressed in brand-new code sets a weak precedent. Either
`#[allow(clippy::cast_possible_truncation)]` with a one-line rationale
or clamp via `usize::try_from().unwrap_or(...)`.

---

## Test Quality

Strong overall.

- `native/src/engine/registry.rs` — 14 unit tests covering registration,
  lookup, merge fallback, capability gates, and warning emission.
- `native/tests/registry_smoke.rs` — 5 integration smokes exercising
  both compiled (runtime, family) pairs, the unregistered-pair error
  shape with the triple in `details`, and the unknown-family fallback.
- `test/plugin-settings.test.ts` — 5 dedicated migration tests for
  `whisper_cpp`, `cohere_onnx`, `external_file`, unknown legacy
  `engineId`, and `schemaVersion` stamping.
- `native/src/installer.rs` — good cancel-race coverage including
  `PendingDownloadSource`.

No tests read as inertia-kept or over-coupled to internals. Known flake:
`poll_event_returns_failed_on_channel_disconnect` is load-sensitive —
already tracked in `docs/lessons.md`, no new action.

Test-quality note: the two `merged_capabilities_with_unknown_family`
tests (`registry.rs:331`, `registry_smoke.rs:106`) only exist because
that method exists. They go away with M2 unless the production wiring
is added.

---

## Architecture

Matches D-008. Dispatch is `registry.lookup((runtime, family)) →
adapter.load → loaded.transcribe` at exactly one site in
`native/src/worker.rs`. Capability gates are centralized in
`apply_capability_gates` with warnings surfaced end-to-end to
`TranscriptReadyEvent`. Adding a new (runtime, family) pair touches only
`EngineRegistry::build` behind a Cargo feature — the OCP promise holds.

No findings on the architecture itself.

---

## Clean Checks

- `cargo check --all-features --tests` — no warnings.
- `tsc --noEmit` — clean.
- `biome check src/ test/` — only L4 above.
- All 14 registry unit tests + 5 smoke tests compile and link under
  both `engine-whisper` and `engine-cohere-transcribe` feature gates.

---

## Open Questions

- Is the 14-tag language breadth in `catalog.json` deliberate
  future-proofing of the wire format, or carry-over from an earlier
  Cohere iteration? Answer changes M4's fix (trim tags vs. document).
- `build_installed_model_capabilities`'s silent drop (M5) — intentional
  hide, or oversight? If intentional, worth a one-line comment at the
  filter site instead of leaving future readers to guess.
- `installedModelCapabilities` and the parsed-but-unused capability
  fields (M3) — is the UI work imminent, or should we trim the wire
  surface area until there's a consumer?

---

## Residual Risk

The Cohere probe gap (M1) is the only item I would block merge on.
Everything else is cleanup or scope-decision work.
