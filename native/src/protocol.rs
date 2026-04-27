use std::io::{ErrorKind, Read, Write};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::{
    CatalogModel, ModelCollection, ModelFamilyDescriptor, ModelRuntimeDescriptor,
};
use crate::engine::capabilities::{
    EngineCapabilities, ModelFamilyCapabilities, ModelFamilyId, RequestWarning,
    RuntimeCapabilities, RuntimeId,
};
use crate::model_store::InstalledModelRecord;
use crate::session::SpeakingStyle;

const JSON_FRAME_KIND: u8 = 0x01;
const AUDIO_FRAME_KIND: u8 = 0x02;
const FRAME_HEADER_LENGTH: usize = 5;
const MAX_FRAME_PAYLOAD: usize = 16 * 1024 * 1024;

pub const PCM_SAMPLE_RATE_HZ: usize = 16_000;
pub const PCM_CHANNEL_COUNT: usize = 1;
pub const PCM_SAMPLE_BYTES: usize = 2;
pub const PCM_FRAME_DURATION_MS: usize = 20;
pub const PCM_SAMPLES_PER_FRAME: usize = (PCM_SAMPLE_RATE_HZ / 1_000) * PCM_FRAME_DURATION_MS;
pub const PCM_BYTES_PER_FRAME: usize = PCM_SAMPLES_PER_FRAME * PCM_CHANNEL_COUNT * PCM_SAMPLE_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SelectedModel {
    CatalogModel {
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        model_id: String,
    },
    ExternalFile {
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        file_path: String,
    },
}

impl SelectedModel {
    pub fn runtime_id(&self) -> RuntimeId {
        match self {
            Self::CatalogModel { runtime_id, .. } | Self::ExternalFile { runtime_id, .. } => {
                *runtime_id
            }
        }
    }

    pub fn family_id(&self) -> ModelFamilyId {
        match self {
            Self::CatalogModel { family_id, .. } | Self::ExternalFile { family_id, .. } => {
                *family_id
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListeningMode {
    AlwaysOn,
    OneSentence,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccelerationPreference {
    #[default]
    Auto,
    CpuOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Listening,
    SpeechDetected,
    SpeechEnding,
    Transcribing,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStopReason {
    SentenceComplete,
    SessionReplaced,
    Timeout,
    UserCancel,
    UserStop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProbeStatus {
    Invalid,
    Missing,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelInstallState {
    Queued,
    Downloading,
    Verifying,
    Probing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub end_ms: u64,
    pub start_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageId {
    Engine,
    HallucinationFilter,
    Punctuation,
    UserRules,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StageStatus {
    Ok,
    Skipped { reason: String },
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOutcome {
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    pub revision_in: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_out: Option<u32>,
    pub stage_id: StageId,
    pub status: StageStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStagePayload {
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContextWindowSource {
    #[serde(rename_all = "camelCase")]
    SessionUtterance {
        end_revision: u32,
        text: String,
        truncated: bool,
        utterance_id: Uuid,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextWindow {
    pub budget_chars: u32,
    pub sources: Vec<ContextWindowSource>,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledRuntimeInfo {
    pub runtime_id: RuntimeId,
    pub display_name: String,
    pub runtime_capabilities: RuntimeCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledAdapterInfo {
    pub runtime_id: RuntimeId,
    pub family_id: ModelFamilyId,
    pub display_name: String,
    pub family_capabilities: ModelFamilyCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct CommandEnvelope {
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    Health,
    StartSession {
        #[serde(default)]
        acceleration_preference: AccelerationPreference,
        language: String,
        mode: ListeningMode,
        model_selection: SelectedModel,
        #[serde(default)]
        model_store_path_override: Option<String>,
        pause_while_processing: bool,
        session_id: String,
        #[serde(default)]
        speaking_style: SpeakingStyle,
    },
    ContextResponse {
        correlation_id: Uuid,
        context: Option<ContextWindow>,
    },
    GetSystemInfo,
    GetModelStore {
        #[serde(default)]
        model_store_path_override: Option<String>,
    },
    ListModelCatalog,
    ListInstalledModels {
        #[serde(default)]
        model_store_path_override: Option<String>,
    },
    ProbeModelSelection {
        model_selection: SelectedModel,
        #[serde(default)]
        model_store_path_override: Option<String>,
    },
    RemoveModel {
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        model_id: String,
        #[serde(default)]
        model_store_path_override: Option<String>,
    },
    InstallModel {
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        install_id: String,
        model_id: String,
        #[serde(default)]
        model_store_path_override: Option<String>,
    },
    CancelModelInstall {
        install_id: String,
    },
    StopSession,
    CancelSession,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct EventEnvelope {
    #[serde(flatten)]
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    HealthOk {
        sidecar_version: String,
        status: HealthStatus,
    },
    ModelStore {
        #[serde(skip_serializing_if = "Option::is_none")]
        override_path: Option<String>,
        path: String,
        using_default_path: bool,
    },
    ModelCatalog {
        catalog_version: u32,
        collections: Vec<ModelCollection>,
        runtimes: Vec<ModelRuntimeDescriptor>,
        families: Vec<ModelFamilyDescriptor>,
        models: Vec<CatalogModel>,
    },
    InstalledModels {
        models: Vec<InstalledModelRecord>,
    },
    ModelProbeResult {
        available: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        installed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        merged_capabilities: Option<EngineCapabilities>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resolved_path: Option<String>,
        selection: SelectedModel,
        #[serde(skip_serializing_if = "Option::is_none")]
        size_bytes: Option<u64>,
        status: ModelProbeStatus,
    },
    ModelRemoved {
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        model_id: String,
        removed: bool,
    },
    ModelInstallUpdate {
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        downloaded_bytes: Option<u64>,
        runtime_id: RuntimeId,
        family_id: ModelFamilyId,
        install_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        model_id: String,
        state: ModelInstallState,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_bytes: Option<u64>,
    },
    SystemInfo {
        sidecar_version: String,
        compiled_runtimes: Vec<CompiledRuntimeInfo>,
        compiled_adapters: Vec<CompiledAdapterInfo>,
        system_info: String,
    },
    SessionStarted {
        mode: ListeningMode,
        session_id: String,
    },
    SessionStateChanged {
        session_id: String,
        state: SessionState,
    },
    TranscriptReady {
        is_final: bool,
        processing_duration_ms: u64,
        revision: u32,
        segments: Vec<TranscriptSegment>,
        session_id: String,
        stage_results: Vec<StageOutcome>,
        text: String,
        utterance_duration_ms: u64,
        utterance_id: Uuid,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<RequestWarning>,
    },
    ContextRequest {
        budget_chars: u32,
        correlation_id: Uuid,
        session_id: String,
        utterance_id: Uuid,
    },
    Warning {
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    SessionStopped {
        reason: SessionStopReason,
        session_id: String,
    },
    Error {
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum IncomingFrame {
    Audio(Vec<u8>),
    Command(Command),
}

impl CommandEnvelope {
    pub fn parse_json(bytes: &[u8]) -> Result<Command> {
        let json_text = std::str::from_utf8(bytes).context("command frame must be valid UTF-8")?;
        let envelope: Self =
            serde_json::from_str(json_text).context("failed to deserialize command envelope")?;

        Ok(envelope.command)
    }
}

impl EventEnvelope {
    pub fn new(event: Event) -> Self {
        Self { event }
    }
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<IncomingFrame>> {
    let mut header = [0_u8; FRAME_HEADER_LENGTH];
    let read_count = read_exact_or_eof(reader, &mut header)?;

    if read_count == 0 {
        return Ok(None);
    }

    let frame_kind = header[0];
    let payload_length = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    ensure!(
        payload_length <= MAX_FRAME_PAYLOAD,
        "frame payload exceeds maximum supported size: {payload_length} > {MAX_FRAME_PAYLOAD}"
    );
    let mut payload = vec![0_u8; payload_length];
    reader
        .read_exact(&mut payload)
        .context("failed to read frame payload")?;

    match frame_kind {
        JSON_FRAME_KIND => Ok(Some(IncomingFrame::Command(CommandEnvelope::parse_json(
            &payload,
        )?))),
        AUDIO_FRAME_KIND => Ok(Some(IncomingFrame::Audio(payload))),
        _ => Err(anyhow!("unsupported frame kind {frame_kind}")),
    }
}

pub fn write_event_frame<W: Write>(writer: &mut W, event: &Event) -> Result<()> {
    let payload = serde_json::to_vec(&EventEnvelope::new(event.clone()))
        .context("failed to serialize event envelope")?;
    write_frame(writer, JSON_FRAME_KIND, &payload)
}

fn write_frame<W: Write>(writer: &mut W, frame_kind: u8, payload: &[u8]) -> Result<()> {
    let payload_length = u32::try_from(payload.len())
        .map_err(|_| anyhow!("payload exceeds maximum frame length"))?;
    let mut header = [0_u8; FRAME_HEADER_LENGTH];

    header[0] = frame_kind;
    header[1..].copy_from_slice(&payload_length.to_le_bytes());

    writer
        .write_all(&header)
        .context("failed to write frame header")?;
    writer
        .write_all(payload)
        .context("failed to write frame payload")?;
    writer.flush().context("failed to flush frame payload")?;

    Ok(())
}

/// Collect system info from all compiled engines into a single string.
pub fn system_info_string() -> String {
    let mut parts = Vec::new();

    #[cfg(feature = "engine-whisper")]
    parts.push(format!("whisper.cpp: {}", whisper_rs::print_system_info()));

    #[cfg(feature = "engine-cohere-transcribe")]
    parts.push("cohere-transcribe: enabled".to_string());

    parts.join(" | ")
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<usize> {
    let mut total_read = 0;

    while total_read < buffer.len() {
        match reader.read(&mut buffer[total_read..]) {
            Ok(0) if total_read == 0 => return Ok(0),
            Ok(0) => bail!("unexpected EOF while reading frame header"),
            Ok(read_count) => total_read += read_count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error).context("failed to read frame header"),
        }
    }

    Ok(total_read)
}

#[cfg(test)]
mod tests {
    use super::{
        AUDIO_FRAME_KIND, AccelerationPreference, Command, Event, EventEnvelope,
        FRAME_HEADER_LENGTH, IncomingFrame, JSON_FRAME_KIND, ListeningMode, MAX_FRAME_PAYLOAD,
        PCM_BYTES_PER_FRAME, SelectedModel, SpeakingStyle, read_frame, write_event_frame,
        write_frame,
    };
    use crate::engine::capabilities::{ModelFamilyId, RuntimeId};

    #[test]
    fn command_frame_round_trip_preserves_start_session_shape() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "type": "start_session",
            "sessionId": "session-1",
            "mode": "always_on",
            "modelSelection": {
                "kind": "external_file",
                "runtimeId": "whisper_cpp",
                "familyId": "whisper",
                "filePath": "/tmp/model.bin"
            },
            "language": "en",
            "pauseWhileProcessing": true
        }))
        .expect("payload should serialize");
        let mut framed = Vec::new();
        write_frame(&mut framed, JSON_FRAME_KIND, &payload).expect("frame should write");

        let parsed = read_frame(&mut framed.as_slice())
            .expect("frame should parse")
            .expect("frame should exist");

        assert_eq!(
            parsed,
            IncomingFrame::Command(Command::StartSession {
                acceleration_preference: AccelerationPreference::Auto,
                language: "en".to_string(),
                mode: ListeningMode::AlwaysOn,
                model_selection: SelectedModel::ExternalFile {
                    runtime_id: RuntimeId::WhisperCpp,
                    family_id: ModelFamilyId::Whisper,
                    file_path: "/tmp/model.bin".to_string(),
                },
                model_store_path_override: None,
                pause_while_processing: true,
                session_id: "session-1".to_string(),
                speaking_style: SpeakingStyle::Balanced,
            })
        );
    }

    #[test]
    fn speaking_style_round_trips_for_all_three_values() {
        for (wire, expected) in [
            ("responsive", SpeakingStyle::Responsive),
            ("balanced", SpeakingStyle::Balanced),
            ("patient", SpeakingStyle::Patient),
        ] {
            let payload = serde_json::to_vec(&serde_json::json!({
                "type": "start_session",
                "sessionId": "session-style",
                "mode": "always_on",
                "modelSelection": {
                    "kind": "external_file",
                    "runtimeId": "whisper_cpp",
                    "familyId": "whisper",
                    "filePath": "/tmp/model.bin"
                },
                "language": "en",
                "pauseWhileProcessing": true,
                "speakingStyle": wire,
            }))
            .expect("payload should serialize");
            let mut framed = Vec::new();
            write_frame(&mut framed, JSON_FRAME_KIND, &payload).expect("frame should write");

            let parsed = read_frame(&mut framed.as_slice())
                .expect("frame should parse")
                .expect("frame should exist");

            let IncomingFrame::Command(Command::StartSession { speaking_style, .. }) = parsed
            else {
                panic!("expected StartSession for wire={wire}");
            };
            assert_eq!(speaking_style, expected, "wire={wire}");
        }
    }

    #[test]
    fn get_system_info_round_trip() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "type": "get_system_info"
        }))
        .expect("payload should serialize");
        let mut framed = Vec::new();
        write_frame(&mut framed, JSON_FRAME_KIND, &payload).expect("frame should write");

        let parsed = read_frame(&mut framed.as_slice())
            .expect("frame should parse")
            .expect("frame should exist");

        assert_eq!(parsed, IncomingFrame::Command(Command::GetSystemInfo));
    }

    #[test]
    fn event_frame_round_trip_preserves_model_store_shape() {
        let event = Event::ModelStore {
            override_path: None,
            path: "/tmp/models".to_string(),
            using_default_path: true,
        };
        let mut framed = Vec::new();
        write_event_frame(&mut framed, &event).expect("frame should write");
        let payload_length =
            u32::from_le_bytes([framed[1], framed[2], framed[3], framed[4]]) as usize;
        let payload = &framed[FRAME_HEADER_LENGTH..FRAME_HEADER_LENGTH + payload_length];
        let parsed: EventEnvelope = serde_json::from_slice(payload).expect("event should parse");

        assert_eq!(parsed.event, event);
    }

    #[test]
    fn audio_frame_round_trip_preserves_payload() {
        let payload = vec![7_u8; PCM_BYTES_PER_FRAME];
        let mut framed = Vec::new();
        write_frame(&mut framed, AUDIO_FRAME_KIND, &payload).expect("frame should write");

        let parsed = read_frame(&mut framed.as_slice())
            .expect("frame should parse")
            .expect("frame should exist");

        assert_eq!(parsed, IncomingFrame::Audio(payload));
    }

    #[test]
    fn oversized_frame_payload_is_rejected_before_allocation() {
        let mut framed = Vec::new();
        framed.push(JSON_FRAME_KIND);
        framed.extend_from_slice(&((MAX_FRAME_PAYLOAD + 1) as u32).to_le_bytes());

        let error = read_frame(&mut framed.as_slice()).expect_err("frame should be rejected");

        assert!(
            error
                .to_string()
                .contains("frame payload exceeds maximum supported size")
        );
    }
}
