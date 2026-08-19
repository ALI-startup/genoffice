//! Resolving a path to its canonical form, on a host that has one.
//!
//! The engine canonicalises before opening a workbook and before comparing a save target
//! with its source, for the reasons `std::fs::canonicalize` exists: two different strings can
//! name one file, and writing over the file you are reading is a corruption bug.
//!
//! `canonicalize` needs a current directory to resolve a relative path against, and
//! `wasm32-wasip1` has no such concept — Rust's std aborts the module rather than guessing.
//! So the browser host gets the honest equivalent instead of the same call: paths there are
//! absolute by construction (the page writes the workbook into its virtual filesystem at a
//! path it chose), that filesystem has no symlinks and no `..` to collapse, and two paths
//! naming one file are therefore the same string. What is left of `canonicalize` in that
//! world is its other job — failing when the file is not there — which is kept.
use std::io;
use std::path::{Path, PathBuf};

/// The canonical form of `path`, or an error when it does not exist.
#[cfg(not(target_family = "wasm"))]
pub fn resolve(path: &Path) -> io::Result<PathBuf> {
    path.canonicalize()
}

/// The wasm equivalent: existence is still checked, and the path is returned as given.
#[cfg(target_family = "wasm")]
pub fn resolve(path: &Path) -> io::Result<PathBuf> {
    // `metadata` follows the same "must exist, must be reachable" rule canonicalize does, and
    // it is the part of the call this host can honour.
    std::fs::metadata(path)?;
    Ok(path.to_path_buf())
}

/// Where the engine may create its per-session scratch directory.
///
/// `std::env::temp_dir()` on the desktop. On `wasm32-wasip1` that call aborts the module —
/// std has no notion of a temp directory there — so the browser host preopens `/tmp` in its
/// virtual filesystem and this returns it. The engine's use of the directory is unchanged:
/// it is where a session's extracted parts live for as long as the workbook is open.
#[cfg(not(target_family = "wasm"))]
pub fn temp_root() -> PathBuf {
    std::env::temp_dir()
}

#[cfg(target_family = "wasm")]
pub fn temp_root() -> PathBuf {
    PathBuf::from("/tmp")
}
