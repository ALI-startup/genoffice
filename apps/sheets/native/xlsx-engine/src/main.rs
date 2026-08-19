//! The desktop sidecar: one process, line-delimited JSON on stdin and stdout.
//!
//! The whole binary is the transport. Every command is dispatched by
//! `xlsx_sidecar::protocol::handle_line`, which the browser host calls too — see wasm.rs.
use std::io::{self, BufRead, BufReader, BufWriter, Write};

use xlsx_sidecar::protocol::{Response, handle_line};
use xlsx_sidecar::recalc::RecalcCache;
use xlsx_sidecar::WorkbookSessions;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    let mut sessions = WorkbookSessions::new();
    let mut recalc_cache = RecalcCache::new();

    for line in BufReader::new(stdin.lock()).lines() {
        let response = match line {
            Ok(line) => handle_line(&line, &mut sessions, &mut recalc_cache),
            Err(error) => Response::failure(
                String::new(),
                "stdin_error",
                format!("Unable to read sidecar request: {error}"),
            ),
        };
        if serde_json::to_writer(&mut output, &response).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            break;
        }
    }
}
