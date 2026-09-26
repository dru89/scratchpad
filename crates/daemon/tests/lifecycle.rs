//! Runs the real scratchpadd binary: persistence across restarts, the
//! single-instance lock, and socket permissions.

use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

struct Env {
    _dir: tempfile::TempDir,
    data: PathBuf,
    socket: PathBuf,
}

impl Env {
    fn new() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let socket = dir.path().join("run/daemon.sock");
        Env { _dir: dir, data, socket }
    }

    fn start(&self) -> Child {
        Command::new(env!("CARGO_BIN_EXE_scratchpadd"))
            .env("SCRATCHPAD_DATA_DIR", &self.data)
            .env("SCRATCHPAD_SOCKET", &self.socket)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }
}

async fn wait_for(socket: &Path) -> UnixStream {
    for _ in 0..200 {
        if let Ok(s) = UnixStream::connect(socket).await {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon never listened on {}", socket.display());
}

async fn call(stream: &mut UnixStream, method: &str, params: Value) -> Value {
    let (r, mut w) = stream.split();
    let line = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string() + "\n";
    w.write_all(line.as_bytes()).await.unwrap();
    let mut reader = BufReader::new(r);
    loop {
        let mut buf = String::new();
        reader.read_line(&mut buf).await.unwrap();
        let v: Value = serde_json::from_str(&buf).unwrap();
        if v.get("id").is_some() {
            return v;
        }
    }
}

#[tokio::test]
async fn drafts_survive_a_restart() {
    let env = Env::new();
    let mut daemon = env.start();
    let mut s = wait_for(&env.socket).await;
    let created = call(&mut s, "drafts.create", json!({ "text": "# Keep me\n\nacross restarts" })).await;
    let id = created["result"]["id"].as_str().unwrap().to_string();
    call(&mut s, "drafts.append", json!({ "id": id, "text": " (appended)" })).await;
    let bye = call(&mut s, "daemon.shutdown", json!({})).await;
    assert!(bye.get("result").is_some(), "shutdown reply should arrive before exit: {bye}");
    assert!(daemon.wait().unwrap().success());
    assert!(!env.socket.exists(), "socket should be removed on shutdown");

    let mut daemon = env.start();
    let mut s = wait_for(&env.socket).await;
    let got = call(&mut s, "drafts.get", json!({ "id": id })).await;
    assert_eq!(got["result"]["text"], "# Keep me\n\nacross restarts (appended)");
    let list = call(&mut s, "drafts.list", json!({ "query": "restarts" })).await;
    assert_eq!(list["result"]["drafts"][0]["title"], "Keep me");
    call(&mut s, "daemon.shutdown", json!({})).await;
    daemon.wait().unwrap();
}

#[tokio::test]
async fn a_second_daemon_exits_and_the_socket_is_private() {
    let env = Env::new();
    let mut first = env.start();
    let mut s = wait_for(&env.socket).await;

    let second = env.start().wait_with_output().unwrap();
    assert!(second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("already running"));

    let mode = std::fs::metadata(&env.socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let dir_mode = std::fs::metadata(env.socket.parent().unwrap()).unwrap().permissions().mode() & 0o777;
    assert_eq!(dir_mode, 0o700);

    // The first daemon is still serving.
    let status = call(&mut s, "daemon.status", json!({})).await;
    assert_eq!(status["result"]["pid"], first.id());
    call(&mut s, "daemon.shutdown", json!({})).await;
    first.wait().unwrap();
}

#[tokio::test]
async fn sigterm_stops_cleanly() {
    let env = Env::new();
    let mut daemon = env.start();
    wait_for(&env.socket).await;
    Command::new("kill").arg(daemon.id().to_string()).status().unwrap();
    assert!(daemon.wait().unwrap().success());
    assert!(!env.socket.exists());
}
