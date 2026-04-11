use std::io::{ErrorKind, Read, Write};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "v2";
pub const JSON_FRAME_KIND: u8 = 0x01;
pub const AUDIO_FRAME_KIND: u8 = 0x02;
pub const FRAME_HEADER_LENGTH: usize = 5;

pub const PCM_SAMPLE_RATE_HZ: usize = 16_000;
pub const PCM_CHANNEL_COUNT: usize = 1;
pub const PCM_SAMPLE_BYTES: usize = 2;
pub const PCM_FRAME_DURATION_MS: usize = 20;
pub const PCM_SAMPLES_PER_FRAME: usize = (PCM_SAMPLE_RATE_HZ / 1_000) * PCM_FRAME_DURATION_MS;
pub const PCM_BYTES_PER_FRAME: usize = PCM_SAMPLES_PER_FRAME * PCM_CHANNEL_COUNT * PCM_SAMPLE_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListeningMode {
    AlwaysOn,
    PressAndHold,
    OneSentence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Listening,
    SpeechDetected,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptSegment {
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Health,
    StartSession {
        language: String,
        mode: ListeningMode,
        #[serde(rename = "modelFilePath")]
        model_file_path: String,
        #[serde(rename = "pauseWhileProcessing")]
        pause_while_processing: bool,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    SetGate {
        open: bool,
    },
    StopSession,
    CancelSession,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(flatten)]
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    HealthOk {
        #[serde(rename = "sidecarVersion")]
        sidecar_version: String,
        status: String,
    },
    SessionStarted {
        mode: ListeningMode,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    SessionStateChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
        state: SessionState,
    },
    TranscriptReady {
        #[serde(rename = "processingDurationMs")]
        processing_duration_ms: u64,
        segments: Vec<TranscriptSegment>,
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
        #[serde(rename = "utteranceDurationMs")]
        utterance_duration_ms: u64,
    },
    Warning {
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        message: String,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    SessionStopped {
        reason: SessionStopReason,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Error {
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
        message: String,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingFrame {
    Audio(Vec<u8>),
    Command(Command),
}

impl CommandEnvelope {
    pub fn parse_json(bytes: &[u8]) -> Result<Command> {
        let json_text = std::str::from_utf8(bytes).context("command frame must be valid UTF-8")?;
        let envelope: Self =
            serde_json::from_str(json_text).context("failed to deserialize command envelope")?;

        ensure!(
            envelope.protocol_version == PROTOCOL_VERSION,
            "unsupported protocol version {}",
            envelope.protocol_version
        );

        Ok(envelope.command)
    }
}

impl EventEnvelope {
    pub fn new(event: Event) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.to_string(),
            event,
        }
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

pub fn write_frame<W: Write>(writer: &mut W, frame_kind: u8, payload: &[u8]) -> Result<()> {
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
        AUDIO_FRAME_KIND, Command, Event, FRAME_HEADER_LENGTH, IncomingFrame, JSON_FRAME_KIND,
        ListeningMode, PCM_BYTES_PER_FRAME, PROTOCOL_VERSION, SessionState, SessionStopReason,
        TranscriptSegment, read_frame, write_event_frame, write_frame,
    };

    #[test]
    fn command_frame_round_trip_preserves_start_session_shape() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "protocolVersion": PROTOCOL_VERSION,
            "type": "start_session",
            "sessionId": "session-1",
            "mode": "always_on",
            "modelFilePath": "/tmp/model.bin",
            "language": "en",
            "pauseWhileProcessing": true
        }))
        .expect("payload should serialize");
        let mut bytes = Vec::new();

        write_frame(&mut bytes, JSON_FRAME_KIND, &payload).expect("frame should serialize");

        let parsed = read_frame(&mut bytes.as_slice())
            .expect("frame should parse")
            .expect("frame should exist");

        assert_eq!(
            parsed,
            IncomingFrame::Command(Command::StartSession {
                language: "en".to_string(),
                mode: ListeningMode::AlwaysOn,
                model_file_path: "/tmp/model.bin".to_string(),
                pause_while_processing: true,
                session_id: "session-1".to_string(),
            })
        );
    }

    #[test]
    fn event_frame_serializes_protocol_version() {
        let mut bytes = Vec::new();

        write_event_frame(
            &mut bytes,
            &Event::SessionStateChanged {
                session_id: "session-1".to_string(),
                state: SessionState::Listening,
            },
        )
        .expect("event should serialize");

        assert_eq!(bytes[0], JSON_FRAME_KIND);

        let payload_length = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        let payload = &bytes[FRAME_HEADER_LENGTH..FRAME_HEADER_LENGTH + payload_length];
        let parsed_json: serde_json::Value =
            serde_json::from_slice(payload).expect("payload should deserialize");

        assert_eq!(
            parsed_json["protocolVersion"],
            serde_json::json!(PROTOCOL_VERSION)
        );
        assert_eq!(
            parsed_json["type"],
            serde_json::json!("session_state_changed")
        );
    }

    #[test]
    fn audio_frame_round_trip_preserves_binary_payload() {
        let payload = vec![7_u8; PCM_BYTES_PER_FRAME];
        let mut bytes = Vec::new();

        write_frame(&mut bytes, AUDIO_FRAME_KIND, &payload).expect("frame should serialize");

        let parsed = read_frame(&mut bytes.as_slice())
            .expect("frame should parse")
            .expect("frame should exist");

        assert_eq!(parsed, IncomingFrame::Audio(payload));
    }

    #[test]
    fn read_frame_rejects_unknown_protocol_version() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "protocolVersion": "v1",
            "type": "health"
        }))
        .expect("payload should serialize");
        let mut bytes = Vec::new();

        write_frame(&mut bytes, JSON_FRAME_KIND, &payload).expect("frame should serialize");

        let error = read_frame(&mut bytes.as_slice()).expect_err("frame should fail");

        assert!(error.to_string().contains("unsupported protocol version"));
    }

    #[test]
    fn read_frame_rejects_unknown_frame_kind() {
        let mut bytes = Vec::new();

        write_frame(&mut bytes, 0xff, &[1, 2, 3]).expect("frame should serialize");

        let error = read_frame(&mut bytes.as_slice()).expect_err("frame should fail");

        assert!(error.to_string().contains("unsupported frame kind"));
    }

    #[test]
    fn transcript_event_shape_matches_expected_fields() {
        let mut bytes = Vec::new();

        write_event_frame(
            &mut bytes,
            &Event::TranscriptReady {
                processing_duration_ms: 125,
                segments: vec![TranscriptSegment {
                    end_ms: 800,
                    start_ms: 0,
                    text: "hello".to_string(),
                }],
                session_id: "session-9".to_string(),
                text: "hello".to_string(),
                utterance_duration_ms: 800,
            },
        )
        .expect("event should serialize");

        let payload_length = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        let payload = &bytes[FRAME_HEADER_LENGTH..FRAME_HEADER_LENGTH + payload_length];
        let parsed_json: serde_json::Value =
            serde_json::from_slice(payload).expect("payload should deserialize");

        assert_eq!(parsed_json["processingDurationMs"], serde_json::json!(125));
        assert_eq!(parsed_json["sessionId"], serde_json::json!("session-9"));
        assert_eq!(parsed_json["utteranceDurationMs"], serde_json::json!(800));
    }

    #[test]
    fn session_stopped_reason_serializes_in_snake_case() {
        let mut bytes = Vec::new();

        write_event_frame(
            &mut bytes,
            &Event::SessionStopped {
                reason: SessionStopReason::SentenceComplete,
                session_id: "session-2".to_string(),
            },
        )
        .expect("event should serialize");

        let payload_length = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        let payload = &bytes[FRAME_HEADER_LENGTH..FRAME_HEADER_LENGTH + payload_length];
        let parsed_json: serde_json::Value =
            serde_json::from_slice(payload).expect("payload should deserialize");

        assert_eq!(
            parsed_json["reason"],
            serde_json::json!("sentence_complete")
        );
    }
}
