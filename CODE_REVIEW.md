# Code Review

## Open Findings

### N-4. Low: Whisper CUDA probe is weaker than Cohere CUDA probe

`native/sidecar/src/capabilities.rs:51-53`: Whisper CUDA checks for `/dev/nvidiactl` and `/dev/nvidia0` device nodes. This confirms the driver is loaded but not that the userspace CUDA runtime libraries (`libcudart.so`, `libcublas.so`) are available. The Cohere probe actually tries to register the CUDA EP, so it catches library-level failures.

This means the settings UI could show `Whisper: CUDA` when Whisper will actually fail at runtime due to missing libraries. The asymmetry is acceptable as a fast heuristic, but worth a comment in the code or a backlog note.

### N-5. High: launch-affecting sidecar settings do not take effect until a manual restart

`src/main.ts:198-200`: The `CUDA library path` and `Sidecar path override` settings both affect the sidecar launch spec, but changing them only persists settings. The already-running sidecar stays alive, and `Check Sidecar Health` only pings that existing process.

Suggested fix: restart the sidecar automatically when launch-affecting settings change while dictation is idle, or block the save with an explicit "restart required" notice and refresh path.

### N-6. Medium: multi-artifact install progress can report impossible totals

`native/sidecar/src/installer.rs:443-450`: `downloaded_total + artifact_downloaded` is cumulative across the whole install, but `total_bytes` falls back to the current artifact's content length when present. For multi-artifact Cohere installs, later files can emit progress like "2.4 GiB / 324 MiB".

Suggested fix: keep `total_bytes` consistently scoped to the full install, or introduce separate per-artifact and aggregate progress fields.

### N-7. Medium: `CUDA library path` replaces inherited `LD_LIBRARY_PATH` instead of extending it

`src/main.ts:230-235`: The child process env merge means the configured value overrides the parent's `LD_LIBRARY_PATH` wholesale. On Linux systems that rely on inherited library-path entries for parts of the CUDA/cuDNN/driver chain, entering one directory in plugin settings can remove the rest.

Suggested fix: append/prepend the configured path to the inherited `LD_LIBRARY_PATH` rather than replacing it.

### R1-6. Medium: KV cache outputs are still matched by iterator position instead of output name

`native/sidecar/src/cohere.rs:510,526`: Code comments acknowledge the assumed output order (`present.{layer}.{decoder,encoder}.{key,value}`). Not yet addressed.

### R3-L4. Low: `isMacOsRuntime()` still uses `process.platform` instead of `Platform.isMacOS`

`src/dictation/shortcut-matcher.ts:107-109`: Should use `Platform.isMacOS` from the `obsidian` package (already used in `main.ts`).
