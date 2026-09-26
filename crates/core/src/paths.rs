//! Where the daemon keeps its data and listens. `SCRATCHPAD_DATA_DIR` and
//! `SCRATCHPAD_SOCKET` override the platform defaults (tests use them).

use anyhow::{Context, Result};
use directories::ProjectDirs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub socket: PathBuf,
}

impl Paths {
    pub fn resolve() -> Result<Paths> {
        let project = ProjectDirs::from("dev", "unremarkable", "scratchpad");
        let data_dir = match std::env::var_os("SCRATCHPAD_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => project.as_ref().context("no home directory")?.data_dir().to_path_buf(),
        };
        // Linux: $XDG_RUNTIME_DIR/scratchpad. macOS has no runtime dir, so the
        // socket lives with the data.
        let socket = match std::env::var_os("SCRATCHPAD_SOCKET") {
            Some(path) => PathBuf::from(path),
            None => project
                .as_ref()
                .and_then(|p| p.runtime_dir())
                .map(|dir| dir.join("daemon.sock"))
                .unwrap_or_else(|| data_dir.join("daemon.sock")),
        };
        Ok(Paths { data_dir, socket })
    }

    pub fn database(&self) -> PathBuf {
        self.data_dir.join("scratchpad.db")
    }

    pub fn lock(&self) -> PathBuf {
        self.data_dir.join("daemon.lock")
    }

    pub fn log(&self) -> PathBuf {
        self.data_dir.join("daemon.log")
    }
}
