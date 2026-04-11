use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use obsidian_local_stt_sidecar::app::{AppState, ControlFlow};
use obsidian_local_stt_sidecar::catalog::ModelCatalog;
use obsidian_local_stt_sidecar::protocol::{Event, IncomingFrame, read_frame, write_event_frame};
use whisper_rs::install_logging_hooks;

enum InputMessage {
    Eof,
    Frame(IncomingFrame),
    ProtocolError(String),
}

fn main() -> Result<()> {
    install_logging_hooks();

    let config = SidecarStartupConfig::from_args(std::env::args().skip(1))?;
    let catalog = ModelCatalog::load_from_path(&config.catalog_path)?;
    run_stdio(catalog)
}

fn run_stdio(catalog: ModelCatalog) -> Result<()> {
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let input_rx = spawn_input_reader();
    let mut app_state = AppState::new(env!("CARGO_PKG_VERSION"), catalog);

    loop {
        write_events(&mut writer, app_state.drain_worker_events())?;

        match input_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(InputMessage::Frame(frame)) => {
                let (control_flow, events) = match frame {
                    IncomingFrame::Audio(frame_bytes) => (
                        ControlFlow::Continue,
                        app_state.handle_audio_frame(frame_bytes),
                    ),
                    IncomingFrame::Command(command) => app_state.handle_command(command),
                };

                write_events(&mut writer, events)?;

                if control_flow == ControlFlow::Shutdown {
                    break;
                }
            }
            Ok(InputMessage::ProtocolError(details)) => {
                write_events(
                    &mut writer,
                    vec![Event::Error {
                        code: "invalid_frame".to_string(),
                        details: Some(details),
                        message: "Failed to parse an incoming protocol frame.".to_string(),
                        session_id: None,
                    }],
                )?;
            }
            Ok(InputMessage::Eof) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(())
}

struct SidecarStartupConfig {
    catalog_path: PathBuf,
}

impl SidecarStartupConfig {
    fn from_args(args: impl IntoIterator<Item = String>) -> Result<Self> {
        let mut catalog_path = None;
        let mut args = args.into_iter();

        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--catalog-path" => {
                    let value = args
                        .next()
                        .ok_or_else(|| anyhow!("--catalog-path requires an absolute path"))?;
                    catalog_path = Some(PathBuf::from(value));
                }
                _ => return Err(anyhow!("unsupported sidecar argument: {argument}")),
            }
        }

        let catalog_path = catalog_path.ok_or_else(|| {
            anyhow!("--catalog-path <absolute-path> is required for the sidecar startup")
        })?;

        if !catalog_path.is_absolute() {
            return Err(anyhow!("--catalog-path must be an absolute path"));
        }

        Ok(Self { catalog_path })
    }
}

fn spawn_input_reader() -> Receiver<InputMessage> {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();

        loop {
            match read_frame(&mut reader) {
                Ok(Some(frame)) => {
                    if tx.send(InputMessage::Frame(frame)).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = tx.send(InputMessage::Eof);
                    break;
                }
                Err(error) => {
                    if tx
                        .send(InputMessage::ProtocolError(format!("{error:#}")))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    rx
}

fn write_events(writer: &mut impl Write, events: Vec<Event>) -> Result<()> {
    for event in events {
        write_event_frame(writer, &event).context("failed to write event frame")?;
    }

    Ok(())
}
