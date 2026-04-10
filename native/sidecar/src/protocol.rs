use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestType {
    Health,
    TranscribeMock,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestEnvelope {
    pub id: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(rename = "type")]
    pub request_type: RequestType,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseEnvelope {
    pub id: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(rename = "type")]
    pub request_type: RequestType,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl RequestEnvelope {
    pub fn parse(line: &str) -> Result<Self> {
        let request: Self =
            serde_json::from_str(line).context("failed to deserialize request envelope")?;

        ensure!(
            request.protocol_version == PROTOCOL_VERSION,
            "unsupported protocol version {}",
            request.protocol_version
        );

        Ok(request)
    }
}

impl ResponseEnvelope {
    pub fn success(id: impl Into<String>, request_type: RequestType, payload: Value) -> Self {
        Self {
            id: id.into(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            request_type,
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    pub fn failure(
        id: impl Into<String>,
        request_type: RequestType,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            request_type,
            ok: false,
            payload: None,
            error: Some(ResponseError {
                code: code.into(),
                message: message.into(),
                details,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PROTOCOL_VERSION, RequestEnvelope, RequestType, ResponseEnvelope};
    use serde_json::json;

    #[test]
    fn request_round_trip_preserves_shape() {
        let request = RequestEnvelope::parse(
            r#"{"id":"req-1","protocolVersion":"v1","type":"health","payload":{}}"#,
        )
        .expect("request should parse");

        assert_eq!(request.id, "req-1");
        assert_eq!(request.protocol_version, PROTOCOL_VERSION);
        assert_eq!(request.request_type, RequestType::Health);
        assert_eq!(request.payload, json!({}));
    }

    #[test]
    fn response_success_serializes_payload() {
        let response = ResponseEnvelope::success(
            "req-1",
            RequestType::Health,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "sidecarVersion": "0.1.0",
                "status": "ready"
            }),
        );

        let serialized = serde_json::to_value(response).expect("response should serialize");

        assert_eq!(serialized["ok"], json!(true));
        assert_eq!(serialized["protocolVersion"], json!(PROTOCOL_VERSION));
        assert_eq!(serialized["type"], json!("health"));
    }

    #[test]
    fn request_parse_rejects_unknown_protocol_version() {
        let error = RequestEnvelope::parse(
            r#"{"id":"req-1","protocolVersion":"v0","type":"health","payload":{}}"#,
        )
        .expect_err("request should fail");

        assert!(error.to_string().contains("unsupported protocol version"));
    }
}
