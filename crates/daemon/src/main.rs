//! scratchpadd: owns the draft store and serves the app, the CLI, and the MCP
//! server over one unix socket (docs/design.md#processes).

mod daemon;
mod server;

use anyhow::{Context, Result};
use scratchpad_core::paths::Paths;
use scratchpad_core::store::Store;
use std::fs::{File, OpenOptions, TryLockError};
use std::os::unix::fs::PermissionsExt;
use tokio::net::UnixListener;

#[tokio::main]
async fn main() -> Result<()> {
    let paths = Paths::resolve()?;
    std::fs::create_dir_all(&paths.data_dir).with_context(|| format!("creating {}", paths.data_dir.display()))?;

    // Held for the life of the process. A second daemon (two clients racing
    // to start one) finds it taken and exits quietly.
    let _lock = match acquire_lock(&paths)? {
        Some(lock) => lock,
        None => {
            eprintln!("scratchpadd: already running");
            return Ok(());
        }
    };

    let socket_dir = paths.socket.parent().context("socket path has no parent")?;
    std::fs::create_dir_all(socket_dir)?;
    std::fs::set_permissions(socket_dir, std::fs::Permissions::from_mode(0o700))?;
    let _ = std::fs::remove_file(&paths.socket);
    let listener = UnixListener::bind(&paths.socket).with_context(|| format!("binding {}", paths.socket.display()))?;
    std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))?;

    let store = Store::open(&paths.database())?;
    let daemon = daemon::Daemon::new(store, Box::new(daemon::wall_clock))?;
    eprintln!(
        "scratchpadd {} (pid {}) listening on {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        paths.socket.display()
    );

    let result = server::run(listener, daemon).await;
    let _ = std::fs::remove_file(&paths.socket);
    eprintln!("scratchpadd: stopped");
    result
}

fn acquire_lock(paths: &Paths) -> Result<Option<File>> {
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(paths.lock())?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e.into()),
    }
}
