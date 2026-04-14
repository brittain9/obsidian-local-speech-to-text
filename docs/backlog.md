# Obsidian Local STT Backlog

## Maintenance

- [ ] Strengthen Whisper CUDA probe to verify userspace libraries, not just device nodes. Current heuristic (`/dev/nvidiactl` + `/dev/nvidia0`) can report CUDA available when `libcudart.so` / `libcublas.so` are missing.
- [ ] KV cache outputs matched by iterator position, not name (`native/sidecar/src/cohere.rs:538-557`). ONNX Runtime does not guarantee output ordering across model versions or opset versions. Current code assumes first output is logits and collects the rest positionally as KV cache. Fix: collect `decoder_outputs` into a `HashMap<String, DynValue>` and look up `"logits"` and each `present.*` cache name explicitly. Medium priority — won't break with current Cohere export but risks silent failures if a model changes.
- [ ] Restart sidecar automatically when launch-affecting settings change (`CUDA library path`, `Sidecar path override`) while dictation is idle, or show an explicit "restart required" notice.
- [ ] Evaluate ONNX Runtime `preload-dylibs` after the current Linux / Flatpak path-based workflow stabilizes. It may simplify Cohere CUDA library loading, but Whisper CUDA still needs sidecar-scoped `LD_LIBRARY_PATH`.


## Later

- [ ] Investigate global push-to-talk or hotkeys without pushing OS-specific assumptions into the core design.
- [ ] Consider showing the active transcript placement mode in the status bar once multiple placement modes ship.
- [ ] Add optional start/stop tones and lightweight processing statistics if the main dictation flow is already reliable.
- [ ] Evaluate single-binary CPU+GPU via ggml backend dlopen registry once whisper.cpp adopts the llama.cpp `GGML_BACKEND_DL` pattern — would eliminate the need for a separate CUDA binary entirely.
- [ ] Tiny model for language detection. Option to use a tiny model for auto language detection instead of the selected model — faster but less accurate. Reference pattern from upstream app.
- [ ] Performance options. Expose engine tuning via profile presets (Best performance / Best quality / Custom). Custom exposes threads, beam width, audio context size, flash attention.

## Blocked

- [ ] Finalize native sidecar distribution and update strategy for community-plugin releases. This includes CPU/CUDA dual-binary packaging where needed, runtime binary selection, checksum/update flow, and CUDA redistribution/licensing constraints.
- [ ] Provision a CUDA-capable CI or release runner so automated release builds can emit Linux CUDA artifacts instead of relying on manual local builds.

## Pipeline (D-007, see `docs/pipeline-architecture.md`)

- [ ] Cohere synthetic segments — produce at least one segment with timing from Cohere backend (`feat/cohere-segments`)
- [ ] TranscriptFormatter layer — extract formatting step between engine output and insertion (`feat/transcript-formatter`)
- [ ] TextProcessor pipeline — composable text transforms between formatting and insertion (`feat/text-processor-pipeline`)
- [ ] Smart cursor insertion — context-aware spacing and capitalization at cursor (`feat/smart-insertion`)
- [ ] Inline timestamp format — `[MM:SS]` prefix per segment, template-based (`feat/inline-timestamps`)
- [ ] Hallucination filtering — detect and strip repeated phrases, phantom words (`feat/hallucination-filter`)
- [ ] User text transformation rules — configurable find/replace rules applied to transcripts (`feat/user-text-rules`)
