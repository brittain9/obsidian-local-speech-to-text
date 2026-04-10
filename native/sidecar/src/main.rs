use std::io::{self, BufRead, Write};

use anyhow::{Context, Result};
use obsidian_local_stt_sidecar::app::{AppState, ControlFlow};
use obsidian_local_stt_sidecar::protocol::RequestEnvelope;
use whisper_rs::install_logging_hooks;

fn main() -> Result<()> {
    install_logging_hooks();

    run_stdio()
}

fn run_stdio() -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let mut app_state = AppState::new(env!("CARGO_PKG_VERSION"));

    for line_result in stdin.lock().lines() {
        let line = line_result.context("failed to read stdin line")?;
        if line.trim().is_empty() {
            continue;
        }

        let request = match RequestEnvelope::parse(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("[local-stt-sidecar] failed to parse request: {error:#}");
                continue;
            }
        };

        let handled = app_state.handle_request(request);

        serde_json::to_writer(&mut writer, &handled.response)
            .context("failed to serialize response envelope")?;
        writer
            .write_all(b"\n")
            .context("failed to terminate response line")?;
        writer.flush().context("failed to flush response")?;

        if handled.control_flow == ControlFlow::Shutdown {
            break;
        }
    }

    Ok(())
}
