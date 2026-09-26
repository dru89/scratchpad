//! Socket plumbing: each connection gets a reader and a writer task; all
//! state changes go through the single daemon task.

use crate::daemon::{ClientId, Daemon};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

const TICK: Duration = Duration::from_millis(200);
const PURGE_EVERY: Duration = Duration::from_secs(60 * 60);

enum Msg {
    Connected(ClientId, mpsc::UnboundedSender<String>),
    Line(ClientId, String),
    Disconnected(ClientId),
    Tick,
    Purge,
    Shutdown,
}

/// Runs until a client calls `daemon.shutdown` or the process gets
/// SIGINT/SIGTERM.
pub async fn run(listener: UnixListener, mut daemon: Daemon) -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();

    let accept_tx = tx.clone();
    tokio::spawn(async move {
        let mut next: ClientId = 0;
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    next += 1;
                    tokio::spawn(serve(stream, next, accept_tx.clone()));
                }
                Err(e) => eprintln!("scratchpadd: accept failed: {e}"),
            }
        }
    });

    let timer_tx = tx.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        let mut purge = tokio::time::interval(PURGE_EVERY); // first tick fires immediately
        loop {
            let msg = tokio::select! {
                _ = tick.tick() => Msg::Tick,
                _ = purge.tick() => Msg::Purge,
            };
            if timer_tx.send(msg).is_err() {
                break;
            }
        }
    });

    let signal_tx = tx.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let (mut term, mut int) = (signal(SignalKind::terminate()).unwrap(), signal(SignalKind::interrupt()).unwrap());
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        let _ = signal_tx.send(Msg::Shutdown);
    });
    drop(tx);

    while let Some(msg) = rx.recv().await {
        match msg {
            Msg::Connected(id, client_tx) => daemon.connect(id, client_tx),
            Msg::Line(id, line) => daemon.handle_line(id, &line),
            Msg::Disconnected(id) => daemon.disconnect(id),
            Msg::Tick => daemon.tick(),
            Msg::Purge => daemon.purge(),
            Msg::Shutdown => daemon.shutdown_requested = true,
        }
        if daemon.shutdown_requested {
            break;
        }
    }
    daemon.flush_dirty(true);
    // Dropping the daemon closes every client's queue; give the writers a
    // moment to send what's left (including the reply to daemon.shutdown).
    drop(daemon);
    tokio::time::sleep(Duration::from_millis(100)).await;
    Ok(())
}

async fn serve(stream: UnixStream, id: ClientId, tx: mpsc::UnboundedSender<Msg>) {
    let (reader, mut writer) = stream.into_split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    if tx.send(Msg::Connected(id, out_tx)).is_err() {
        return;
    }
    let write = tokio::spawn(async move {
        while let Some(mut line) = out_rx.recv().await {
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() && tx.send(Msg::Line(id, line)).is_err() {
            break;
        }
    }
    let _ = tx.send(Msg::Disconnected(id));
    // The writer ends once the daemon drops this client's queue.
    let _ = write.await;
}
