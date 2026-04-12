# Code Review

Scope: recent Cohere feature work, limited to confirmed build, distribution, CI, and runtime contract issues.

## Findings

### 1. High: the documented Linux CUDA flow builds the wrong sidecar variants

Evidence:
- `docs/linux-flatpak-gpu-setup.md` tells users to run `bash scripts/linux_cuda_build.sh --no-clean`.
- `scripts/linux_cuda_build.sh` builds the CPU sidecar with no explicit features.
- The same script builds the CUDA sidecar with `--features gpu-cuda` only.

Impact:
- The CPU artifact produced by the script does not include the Cohere engine.
- The CUDA artifact produced by the script enables Whisper CUDA, but not Cohere ONNX CUDA.
- Users following the repo's own Linux GPU guide do not get the intended shipped engine set.

Suggested fix:
- Change the script's CPU build to include `--features engine-cohere`.
- Change the script's CUDA build to include the full intended feature set for a shipped CUDA sidecar, not just `gpu-cuda`. If the intent is "Whisper + Cohere with CUDA where available", that likely means `engine-cohere,gpu-cuda,gpu-ort-cuda`.
- Prefer a single Cargo feature alias for each supported build profile so scripts and docs stop hard-coding overlapping feature lists. Example direction:
  - `sidecar-default = ["engine-cohere"]`
  - `sidecar-cuda = ["sidecar-default", "gpu-cuda", "gpu-ort-cuda"]`
- After fixing the script, keep `docs/linux-flatpak-gpu-setup.md` explicit about which engines and GPU paths the generated binaries actually contain.

Affected files:
- `docs/linux-flatpak-gpu-setup.md`
- `scripts/linux_cuda_build.sh`
- `native/sidecar/Cargo.toml`

### 2. High: the npm GPU build target has drifted from the actual Cargo feature model

Evidence:
- `package.json` defines `build:sidecar:gpu` as `cargo build ... --features engine-cohere,gpu-cuda`.
- `native/sidecar/Cargo.toml` splits Whisper CUDA and Cohere CUDA into separate flags: `gpu-cuda` and `gpu-ort-cuda`.
- `native/sidecar/src/cohere.rs` only registers the ONNX CUDA execution provider behind `gpu-ort-cuda`.
- `native/sidecar/src/protocol.rs` only reports `ort-cuda` in `compiled_backends()` when `gpu-ort-cuda` is enabled.

Impact:
- `npm run build:sidecar:gpu` does not produce a fully GPU-enabled Cohere build.
- The command name implies "GPU sidecar", but the resulting binary only covers the Whisper CUDA path.
- This is the kind of feature-flag drift that will keep resurfacing anywhere the build profile is re-expressed manually.

Suggested fix:
- Update `build:sidecar:gpu` to use the full intended GPU feature set, not just `engine-cohere,gpu-cuda`.
- Use the same Cargo feature alias strategy as above so `package.json`, shell scripts, and any future release automation all target one source of truth.
- Add one high-signal verification step for shipped build profiles. The simplest option is a small Rust assertion around `compiled_backends()` under the supported feature combinations, so feature drift is caught before docs and helper scripts diverge again.

Affected files:
- `package.json`
- `native/sidecar/Cargo.toml`
- `native/sidecar/src/cohere.rs`
- `native/sidecar/src/protocol.rs`

### 3. High: the decoder prompt uses invalid hard-coded token IDs and fails at runtime on Cohere Q4

Evidence:
- `native/sidecar/src/cohere.rs` still hard-codes prompt token IDs like `TOKEN_START_OF_CONTEXT = 16384`.
- Running the CPU debug sidecar against Cohere Q4 fails inside ONNX Runtime's quantized embedding gather with:
  - `indices element out of data bounds, idx=16384 must be within the inclusive range [-16384,16383]`
- The shipped model config declares a vocabulary size of `16384`, so valid token IDs are `0..16383`.
- The official processor does not hard-code numeric prompt IDs. It builds the decoder prompt from token strings and converts them through the tokenizer.

Impact:
- Decoder inference fails on the first prompt step before any real generation happens.
- This is a confirmed runtime defect in the current backend, not a CPU-only artifact and not a test-only mismatch.
- Any build that reaches the decoder path will remain broken until prompt construction is fixed.

Suggested fix:
- Remove the hard-coded `TOKEN_*` numeric prompt IDs from `native/sidecar/src/cohere.rs`.
- Build decoder prompt IDs from tokenizer token strings loaded from the shipped tokenizer data, matching the official processor contract.
- Add an explicit guard before decoder invocation that rejects any token ID outside `[0, vocab_size)`.
- Use the official prompt structure instead of the current five-token approximation.

Affected files:
- `native/sidecar/src/cohere.rs`
- `tokenizer.json` loader path in the native sidecar

External references:
- `https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX/blob/main/config.json`
- `https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX/blob/main/tokenizer_config.json`
- `https://raw.githubusercontent.com/huggingface/transformers/main/src/transformers/models/cohere_asr/processing_cohere_asr.py`

### 4. High: the new mel feature extractor still does not match the shipped Cohere preprocessing pipeline

Evidence:
- `native/sidecar/src/mel.rs` currently uses custom xorshift dither, a hand-built HTK mel filterbank, a periodic Hann window, and manual framing/STFT behavior.
- The official Cohere feature extractor uses:
  - Gaussian dither seeded by valid waveform length
  - `librosa.filters.mel(..., norm="slaney")`
  - `torch.hann_window(..., periodic=False)`
  - centered `torch.stft(..., pad_mode="constant")`
  - per-feature normalization over valid frames only, with variance divided by `(features_lengths - 1)`
- The repo implementation now fixes tensor rank and shape, but it still feeds numerically different features into the encoder.

Impact:
- The encoder can run, but the model is still likely receiving materially different acoustic features than it was trained and exported with.
- This is the kind of mismatch that produces poor or unstable transcripts even when all tensor names and shapes are correct.
- Manual testing after the decoder fix may still look "broken" unless preprocessing parity is improved.

Suggested fix:
- Rework `native/sidecar/src/mel.rs` to mirror the official feature extractor more closely instead of relying on "standard DSP" approximations.
- Match the official windowing, centering, mel filter construction, dither behavior, and masked normalization rules.
- Add a golden-reference comparison test against known-good features from the official processor for one or two short audio fixtures.

Affected files:
- `native/sidecar/src/mel.rs`
- `native/sidecar/src/cohere.rs`

External references:
- `https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX/blob/main/preprocessor_config.json`
- `https://github.com/huggingface/transformers/blob/main/src/transformers/models/cohere_asr/feature_extraction_cohere_asr.py`

### 5. Medium: detokenization still bypasses tokenizer semantics

Evidence:
- `native/sidecar/src/cohere.rs` currently detokenizes by joining raw vocab strings and decoding `<0xNN>` byte patterns.
- The official processor delegates decode behavior to the tokenizer and uses tokenizer-aware text reconstruction for chunked outputs.
- The current implementation also skips "special tokens" using `id >= TOKEN_START_OF_CONTEXT`, which is no longer a defensible rule once the hard-coded IDs are removed.

Impact:
- Even after decoder generation succeeds, emitted text can still be wrong due to incorrect handling of special tokens, byte-level pieces, or tokenizer-specific decoding rules.
- This creates a second layer of false negatives during runtime testing because model quality and text post-processing failures are conflated.

Suggested fix:
- Replace the ad hoc `detokenize` path with tokenizer-driven decoding based on the shipped tokenizer data.
- Stop encoding special-token rules as numeric thresholds.
- Add one or two high-signal decode tests using real tokenizer entries that cover special tokens and byte-piece reconstruction.

Affected files:
- `native/sidecar/src/cohere.rs`
- tokenizer loading and decode support in the native sidecar

External references:
- `https://raw.githubusercontent.com/huggingface/transformers/main/src/transformers/models/cohere_asr/processing_cohere_asr.py`
- `https://huggingface.co/onnx-community/cohere-transcribe-03-2026-ONNX/blob/main/tokenizer_config.json`

### 6. Medium: KV cache outputs are still matched by iterator position instead of output name

Evidence:
- `native/sidecar/src/cohere.rs` collects `present.*` tensors from decoder outputs by iteration order and stores them as the next step's KV cache.
- Earlier Cohere decoder bugs in this repo were caused by assuming ONNX contracts instead of binding to the actual graph names.
- The current code now uses correct input cache names, but it still assumes output ordering rather than binding cache tensors by returned output name.

Impact:
- If the model output order differs from the assumed `present.{layer}.{decoder,encoder}.{key,value}` sequence, cache tensors can be silently misassigned across layers or attention types.
- That kind of corruption is difficult to diagnose because the decoder may still run while producing degraded or unstable output.

Suggested fix:
- Bind returned cache tensors by output name, not iterator position.
- Validate that all expected `present.*` outputs are present before caching them for the next step.
- Add one targeted assertion test around cache name ordering if the ORT wrapper API allows it.

Affected files:
- `native/sidecar/src/cohere.rs`

### 7. Medium: GitHub Actions is currently failing on a formatting regression in the Cohere Rust file

Evidence:
- The only CI workflow runs `npm run check` in `.github/workflows/ci.yml`.
- Reproducing the Rust half locally with `npm run check:rust` fails at `cargo fmt --manifest-path native/sidecar/Cargo.toml --check`.
- The reported diff is in `native/sidecar/src/cohere.rs`, around the `load_vocab_parses_tokenizer_json` test.

Impact:
- Every push that includes this state will show the repository's single CI job as failed.
- This masks higher-signal failures until the formatting break is cleared.
- The failure shown in GitHub is a real repo issue, not just a GitHub-hosted runner artifact.

Suggested fix:
- Run `cargo fmt --manifest-path native/sidecar/Cargo.toml` and commit the formatted Rust file.
- Keep `npm run check:rust` or at least `cargo fmt --check` in the local pre-push workflow for Rust changes so formatting regressions do not make it to CI.
- If desired, split formatting into its own workflow step in `.github/workflows/ci.yml` so future failures are immediately obvious from the Actions UI.

Affected files:
- `native/sidecar/src/cohere.rs`
- `.github/workflows/ci.yml`
