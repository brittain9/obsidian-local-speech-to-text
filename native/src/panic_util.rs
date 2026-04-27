use std::any::Any;

/// Render a `catch_unwind` panic payload as a human-readable string. Standard
/// library panics carry either `&'static str` or `String` payloads; anything
/// else falls back to a bare `"{prefix}."` since we have no portable way to
/// stringify arbitrary types.
pub fn format_panic_message(payload: &(dyn Any + Send), prefix: &str) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return format!("{prefix}: {s}");
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return format!("{prefix}: {s}");
    }
    format!("{prefix}.")
}
