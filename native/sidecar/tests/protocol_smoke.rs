use obsidian_local_stt_sidecar::app::{AppState, ControlFlow};
use obsidian_local_stt_sidecar::protocol::{RequestEnvelope, RequestType};
use serde_json::json;

#[test]
fn transcribe_file_invalid_payload_smoke_test() {
    let handled = AppState::new("0.1.0").handle_request(RequestEnvelope {
        id: "req-42".to_string(),
        protocol_version: "v1".to_string(),
        request_type: RequestType::TranscribeFile,
        payload: json!({}),
    });

    assert_eq!(handled.control_flow, ControlFlow::Continue);
    assert!(!handled.response.ok);
    assert_eq!(
        handled
            .response
            .error
            .expect("error payload should exist")
            .code,
        "invalid_request_payload"
    );
}
