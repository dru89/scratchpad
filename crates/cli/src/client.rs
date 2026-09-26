//! A connection to scratchpadd. Starts the daemon if nothing is listening
//! (docs/design.md#processes).

use anyhow::{Context, Result, bail};
use scratchpad_core::paths::Paths;
use scratchpad_core::protocol::{self as proto, RpcError};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

pub struct Client {
    reader: Lines<BufReader<OwnedReadHalf>>,
    writer: OwnedWriteHalf,
    next_id: u64,
}

impl Client {
    /// Connects, starting the daemon first if it isn't running.
    pub async fn connect(paths: &Paths, kind: &str) -> Result<Client> {
        let stream = match UnixStream::connect(&paths.socket).await {
            Ok(stream) => stream,
            Err(_) => {
                spawn_daemon(paths)?;
                wait_for_daemon(paths).await?
            }
        };
        Self::handshake(stream, kind).await
    }

    /// Connects only if the daemon is already running.
    pub async fn connect_existing(paths: &Paths, kind: &str) -> Result<Option<Client>> {
        match UnixStream::connect(&paths.socket).await {
            Ok(stream) => Ok(Some(Self::handshake(stream, kind).await?)),
            Err(_) => Ok(None),
        }
    }

    async fn handshake(stream: UnixStream, kind: &str) -> Result<Client> {
        let (reader, writer) = stream.into_split();
        let mut client = Client { reader: BufReader::new(reader).lines(), writer, next_id: 0 };
        let hello: proto::HelloResult = client
            .call(
                "hello",
                json!({
                    "protocol": proto::PROTOCOL_VERSION,
                    "client": { "kind": kind, "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await?;
        if hello.protocol != proto::PROTOCOL_VERSION {
            bail!(
                "scratchpadd {} speaks protocol {}, but this scratchpad speaks {}; run `scratchpad daemon stop` and try again",
                hello.version,
                hello.protocol,
                proto::PROTOCOL_VERSION
            );
        }
        Ok(client)
    }

    /// Sends a request and waits for its reply, skipping notifications.
    /// Daemon errors come back as an `RpcError` inside the anyhow error.
    pub async fn call<T: DeserializeOwned>(&mut self, method: &str, params: Value) -> Result<T> {
        self.next_id += 1;
        let id = self.next_id;
        let mut line = proto::request(id, method, params);
        line.push('\n');
        self.writer.write_all(line.as_bytes()).await.context("lost connection to scratchpadd")?;
        loop {
            let line = self.reader.next_line().await?.context("scratchpadd closed the connection")?;
            let msg: Value = serde_json::from_str(&line)?;
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                let err: RpcError = serde_json::from_value(err.clone())?;
                return Err(err.into());
            }
            return Ok(serde_json::from_value(msg["result"].clone())?);
        }
    }
}

fn daemon_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("SCRATCHPAD_DAEMON") {
        return path.into();
    }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("scratchpadd");
        if sibling.exists() {
            return sibling;
        }
    }
    PathBuf::from("scratchpadd")
}

/// Starts scratchpadd in its own process group, logging to the data dir. If
/// two clients race, the daemon's lock file makes the loser exit.
fn spawn_daemon(paths: &Paths) -> Result<()> {
    std::fs::create_dir_all(&paths.data_dir)?;
    let log = OpenOptions::new().create(true).append(true).open(paths.log())?;
    let binary = daemon_binary();
    Command::new(&binary)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .with_context(|| format!("starting {}", binary.display()))?;
    Ok(())
}

async fn wait_for_daemon(paths: &Paths) -> Result<UnixStream> {
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(30)).await;
        if let Ok(stream) = UnixStream::connect(&paths.socket).await {
            return Ok(stream);
        }
    }
    bail!("scratchpadd didn't start; see {}", paths.log().display())
}
