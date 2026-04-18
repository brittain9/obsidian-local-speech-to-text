#[cfg(feature = "engine-cohere-transcribe")]
pub mod onnx;

#[cfg(feature = "engine-whisper")]
pub mod whisper_cpp;
