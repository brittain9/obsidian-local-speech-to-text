//! Integration smoke tests that build the real `EngineRegistry` under both
//! feature gates and exercise the dispatch path for each compiled (runtime,
//! family) pair end-to-end. No real inference is performed — real models are
//! multi-hundred-megabyte artifacts that cannot live in the repo. These tests
//! validate the registry contract: every compiled pair is registered, merged
//! capabilities are reported, and missing-adapter lookups fail in the expected
//! structured way.

use std::path::Path;

use local_transcript_sidecar::engine::{
    AcceleratorId, EngineRegistry, ModelFamilyId, RuntimeId, missing_adapter_error,
};

#[cfg(feature = "engine-whisper")]
#[test]
fn whisper_pair_is_registered_when_compiled() {
    let registry = EngineRegistry::build();

    let adapter = registry
        .adapter(RuntimeId::WhisperCpp, ModelFamilyId::Whisper)
        .expect("whisper adapter must be registered when engine-whisper is on");
    assert_eq!(adapter.runtime_id(), RuntimeId::WhisperCpp);
    assert_eq!(adapter.family_id(), ModelFamilyId::Whisper);

    let merged = registry
        .merged_capabilities(RuntimeId::WhisperCpp, ModelFamilyId::Whisper)
        .expect("merged capabilities must be present for compiled pair");
    assert!(merged.family.supports_segment_timestamps);
    assert!(
        merged
            .runtime
            .available_accelerators
            .contains(&AcceleratorId::Cpu)
    );
}

#[cfg(feature = "engine-cohere-transcribe")]
#[test]
fn cohere_pair_is_registered_when_compiled() {
    let registry = EngineRegistry::build();

    let adapter = registry
        .adapter(RuntimeId::OnnxRuntime, ModelFamilyId::CohereTranscribe)
        .expect("cohere adapter must be registered when engine-cohere-transcribe is on");
    assert_eq!(adapter.runtime_id(), RuntimeId::OnnxRuntime);
    assert_eq!(adapter.family_id(), ModelFamilyId::CohereTranscribe);

    let merged = registry
        .merged_capabilities(RuntimeId::OnnxRuntime, ModelFamilyId::CohereTranscribe)
        .expect("merged capabilities must be present for compiled pair");
    assert!(merged.family.max_audio_duration_secs.is_some());
    assert!(
        merged
            .runtime
            .available_accelerators
            .contains(&AcceleratorId::Cpu)
    );
}

#[test]
fn probe_against_missing_path_surfaces_structured_error_for_registered_pair() {
    let registry = EngineRegistry::build();

    // Pick the first registered pair available under this build's features.
    let maybe_pair = registry
        .adapters()
        .next()
        .map(|adapter| (adapter.runtime_id(), adapter.family_id()));

    let Some((runtime_id, family_id)) = maybe_pair else {
        // No adapters compiled in — nothing to probe. The cross-cutting
        // "missing-adapter" path is still covered by the next test below.
        return;
    };

    let err = registry
        .probe_model(runtime_id, family_id, Path::new("/nonexistent.bin"))
        .expect_err("probing a nonexistent path must fail");
    assert!(!err.code.is_empty());
}

#[test]
fn unregistered_pair_surfaces_missing_adapter_error_with_triple_in_details() {
    // Fabricate an (runtime, family) pair that neither feature ever registers
    // naturally: whisper_cpp + cohere_transcribe.
    let registry = EngineRegistry::build();
    let err = registry
        .probe_model(
            RuntimeId::WhisperCpp,
            ModelFamilyId::CohereTranscribe,
            Path::new("/nonexistent.bin"),
        )
        .expect_err("probe must fail because this pair is never registered");
    assert_eq!(err.code, "unsupported_engine");
    let details = err.details.clone().expect("details set");
    assert!(details.contains("whisper_cpp"));
    assert!(details.contains("cohere_transcribe"));

    // Hand-rolled helper should produce the same error code + contents.
    let direct = missing_adapter_error(RuntimeId::WhisperCpp, ModelFamilyId::CohereTranscribe);
    assert_eq!(direct.code, err.code);
}

#[test]
fn merged_capabilities_falls_back_to_unknown_when_family_adapter_missing() {
    let registry = EngineRegistry::build();

    let Some(runtime_id) = registry.runtimes().next().map(|runtime| runtime.id()) else {
        return;
    };

    // Pair the runtime with a family the registry won't have for it (the sole
    // registered pair per runtime pins to a single family id), which forces the
    // unknown-family fallback path. When no mismatch is available we skip.
    let family_id = [ModelFamilyId::Whisper, ModelFamilyId::CohereTranscribe]
        .into_iter()
        .find(|family| registry.adapter(runtime_id, *family).is_none());
    let Some(family_id) = family_id else {
        return;
    };

    let merged = registry
        .merged_capabilities(runtime_id, family_id)
        .expect("runtime is registered so merge succeeds");
    assert!(!merged.family.supports_segment_timestamps);
    assert!(!merged.family.supports_initial_prompt);
    assert!(!merged.family.supports_language_selection);
    assert!(merged.family.max_audio_duration_secs.is_none());
}
