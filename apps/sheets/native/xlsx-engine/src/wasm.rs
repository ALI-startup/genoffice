//! The browser host's entry point: the same dispatcher, reached through linear memory.
//!
//! The desktop sidecar is a process, so its transport is a pipe and its protocol is
//! line-delimited JSON. A browser has no process to spawn, so this module exposes the
//! dispatcher directly: the caller writes a request's UTF-8 bytes into the module's memory
//! and reads the response's bytes back out. The JSON on both sides is byte-identical to what
//! crosses the pipe, because it is produced by the same `protocol::handle_line`.
//!
//! No wasm-bindgen. Four `extern "C"` functions and a length-prefixed buffer are the whole
//! ABI, which keeps the build a plain `cargo build --target wasm32-wasip1` with no
//! version-matched code generator in the middle, and keeps the glue on the other side small
//! enough to read (apps/sheets/src/renderer/wasm/).
//!
//! **Files still exist here.** The module is built for `wasm32-wasip1`, and every command
//! still names a path, because the host provides a WASI filesystem: the page writes the
//! workbook's bytes into it before calling `open`, and reads a saved archive back out of it
//! afterwards. That is what lets a browser run this engine with *no* changes to the seven
//! thousand lines above it — the same session cache, the same archive rewriting, the same
//! formula model. A byte-oriented rewrite of that boundary would have been a second
//! implementation to keep in step, which is the one thing this migration refuses to do.
//!
//! The sessions and the recalc cache live in thread-locals: a wasm module is single-threaded
//! and this is the only code that reaches them, so each entry point borrows them for exactly
//! the length of one call and returns nothing that borrows them afterwards.
use std::cell::RefCell;

use crate::WorkbookSessions;
use crate::protocol::{Response, handle_line};
use crate::recalc::RecalcCache;

thread_local! {
    static SESSIONS: RefCell<WorkbookSessions> = RefCell::new(WorkbookSessions::new());
    static RECALC: RefCell<RecalcCache> = RefCell::new(RecalcCache::new());
    /// The response of the last `xlsx_handle` call, kept alive until the caller reads it.
    static LAST: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Reserve `len` bytes for the caller to write a request into. Freed by `xlsx_free`.
///
/// # Safety
/// The returned pointer is valid for `len` bytes until passed back to `xlsx_free` or
/// `xlsx_handle`.
#[unsafe(no_mangle)]
pub extern "C" fn xlsx_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Release a buffer obtained from `xlsx_alloc` that was never handed to `xlsx_handle`.
///
/// # Safety
/// `pointer`/`len` must be exactly what `xlsx_alloc` returned and was called with.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xlsx_free(pointer: *mut u8, len: usize) {
    if pointer.is_null() {
        return;
    }
    drop(unsafe { Vec::from_raw_parts(pointer, 0, len) });
}

/// Dispatch one request and keep the response until the next call.
///
/// Returns the response's length; the bytes are at `xlsx_response_ptr()`. Two calls rather
/// than one because a wasm export returns a single value, and a length-prefixed buffer would
/// have to be parsed on the JS side anyway.
///
/// # Safety
/// `pointer`/`len` must describe a buffer from `xlsx_alloc` holding UTF-8; this call takes
/// ownership of it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn xlsx_handle(pointer: *mut u8, len: usize) -> usize {
    let request = unsafe { Vec::from_raw_parts(pointer, len, len) };
    // Invalid UTF-8 is answered in the protocol's own shape rather than by trapping: a
    // trapped module is unusable afterwards, and a bad request must not cost the page its
    // open workbook.
    let response = match std::str::from_utf8(&request) {
        Ok(line) => SESSIONS.with_borrow_mut(|sessions| {
            RECALC.with_borrow_mut(|recalc| handle_line(line, sessions, recalc))
        }),
        Err(error) => Response::failure(
            String::new(),
            "invalid_json",
            format!("Sidecar request was not valid UTF-8: {error}"),
        ),
    };
    let bytes = serde_json::to_vec(&response).unwrap_or_else(|error| {
        // Serializing a Response cannot normally fail; if it somehow does, answer with a
        // hand-built error rather than panicking across the ABI boundary.
        format!(
            "{{\"version\":1,\"requestId\":\"\",\"ok\":false,\"error\":{{\"code\":\"io_error\",\"message\":\"Sidecar could not encode its response: {error}\"}}}}"
        )
        .into_bytes()
    });
    let length = bytes.len();
    LAST.with_borrow_mut(|last| *last = bytes);
    length
}

/// Pointer to the bytes of the last `xlsx_handle` response.
#[unsafe(no_mangle)]
pub extern "C" fn xlsx_response_ptr() -> *const u8 {
    LAST.with_borrow(|last| last.as_ptr())
}
