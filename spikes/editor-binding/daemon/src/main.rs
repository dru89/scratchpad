// Spike daemon: owns Loro documents and relays updates between clients over
// line-delimited JSON-RPC on a unix socket. Shaped like the real scratchpadd
// (docs/design.md), minus SQLite, titles, and search. The `spike.*` methods
// exist only to drive the binding tests.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use loro::{CommitOptions, ExportMode, LoroDoc, UpdateOptions, VersionVector};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

type ClientId = u64;
type Tx = mpsc::UnboundedSender<String>;

struct Doc {
    doc: LoroDoc,
    subscribers: HashSet<ClientId>,
    dirty: bool,
}

#[derive(Default)]
struct State {
    docs: HashMap<String, Doc>,
    clients: HashMap<ClientId, Tx>,
    next_client: ClientId,
}

type Shared = Arc<Mutex<State>>;

fn runtime_dir() -> PathBuf {
    let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(base).join("scratchpad-spike")
}

fn data_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share"));
    base.join("scratchpad-spike").join("docs")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn doc_path(id: &str) -> PathBuf {
    data_dir().join(format!("{id}.loro"))
}

fn save(id: &str, doc: &LoroDoc) -> std::io::Result<()> {
    let bytes = doc.export(ExportMode::Snapshot).expect("snapshot export");
    let path = doc_path(id);
    let tmp = path.with_extension("loro.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)
}

/// Loads a document from disk into the state if it isn't already there.
fn ensure_loaded(st: &mut State, id: &str) -> Result<(), String> {
    if st.docs.contains_key(id) {
        return Ok(());
    }
    let bytes = std::fs::read(doc_path(id)).map_err(|_| format!("no such draft: {id}"))?;
    let doc = LoroDoc::new();
    doc.import(&bytes).map_err(|e| e.to_string())?;
    st.docs.insert(id.into(), Doc { doc, subscribers: HashSet::new(), dirty: false });
    Ok(())
}

fn notify(tx: &Tx, method: &str, params: Value) {
    let _ = tx.send(json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string());
}

/// Sends a Loro update to every subscriber of `id` except `except`.
fn broadcast(st: &State, id: &str, except: Option<ClientId>, update: &[u8]) {
    let Some(entry) = st.docs.get(id) else { return };
    let params = json!({"id": id, "update": B64.encode(update)});
    for client in &entry.subscribers {
        if Some(*client) == except {
            continue;
        }
        if let Some(tx) = st.clients.get(client) {
            notify(tx, "doc.update", params.clone());
        }
    }
}

fn stamp_modified(doc: &LoroDoc) {
    let _ = doc.get_map("meta").insert("modifiedAt", now_ms());
}

/// Applies an edit on the daemon's own peer (standing in for an agent or the
/// CLI), then relays the resulting update to every open window.
fn agent_edit(state: &Shared, id: &str, f: impl FnOnce(&LoroDoc) -> Result<(), String>) -> Result<Value, String> {
    let mut st = state.lock().unwrap();
    ensure_loaded(&mut st, id)?;
    let entry = st.docs.get_mut(id).unwrap();
    let before = entry.doc.oplog_vv();
    let t0 = Instant::now();
    f(&entry.doc)?;
    stamp_modified(&entry.doc);
    entry.doc.commit_with(CommitOptions::new().origin("agent"));
    let edit_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let update = entry.doc.export(ExportMode::updates(&before)).map_err(|e| e.to_string())?;
    entry.dirty = true;
    let version = B64.encode(entry.doc.oplog_vv().encode());
    broadcast(&st, id, None, &update);
    Ok(json!({"version": version, "editMs": edit_ms, "updateBytes": update.len()}))
}

fn str_param<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    p.get(key).and_then(Value::as_str).ok_or_else(|| format!("missing param {key}"))
}

fn id_param(p: &Value) -> Result<String, String> {
    let id = str_param(p, "id")?;
    if !valid_id(id) {
        return Err("bad id".into());
    }
    Ok(id.into())
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const STORM_WORDS: &[&str] = &["AGENT", "merged", "rewritten", "remote", "edited", "SYNC", "loro", "patched"];

/// Replaces a random word within 400 characters of `near` by rewriting the
/// whole body through LoroText::update, the path an agent's setText takes.
fn storm_edit(doc: &LoroDoc, near: usize, rng: &mut Rng) -> Result<(), String> {
    let body = doc.get_text("body");
    let text = body.to_string();
    let bytes = text.as_bytes();
    let lo = near.saturating_sub(400).min(bytes.len());
    let hi = (near + 400).min(bytes.len());
    let mut words = Vec::new();
    let mut i = lo;
    while i < hi {
        if bytes[i].is_ascii_alphabetic() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            if i - start >= 3 {
                words.push((start, i));
            }
        }
        i += 1;
    }
    if words.is_empty() {
        return Ok(());
    }
    let (s, e) = words[rng.below(words.len())];
    let replacement = STORM_WORDS[rng.below(STORM_WORDS.len())];
    let new_text = format!("{}{}{}", &text[..s], replacement, &text[e..]);
    body.update(&new_text, UpdateOptions::default()).map_err(|e| format!("{e:?}"))
}

fn handle(state: &Shared, client: ClientId, tx: &Tx, method: &str, p: &Value) -> Result<Value, String> {
    match method {
        "hello" => Ok(json!({"protocol": 1, "daemon": "spike-daemon", "pid": std::process::id()})),

        "doc.open" => {
            let id = id_param(p)?;
            let mut st = state.lock().unwrap();
            ensure_loaded(&mut st, &id)?;
            let entry = st.docs.get_mut(&id).unwrap();
            entry.subscribers.insert(client);
            let data = match p.get("version").and_then(Value::as_str) {
                Some(v) => {
                    let vv = VersionVector::decode(&B64.decode(v).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    entry.doc.export(ExportMode::updates(&vv))
                }
                None => entry.doc.export(ExportMode::Snapshot),
            }
            .map_err(|e| e.to_string())?;
            Ok(json!({"data": B64.encode(&data), "version": B64.encode(entry.doc.oplog_vv().encode())}))
        }

        "doc.push" => {
            let id = id_param(p)?;
            let update = B64.decode(str_param(p, "update")?).map_err(|e| e.to_string())?;
            let mut st = state.lock().unwrap();
            ensure_loaded(&mut st, &id)?;
            let entry = st.docs.get_mut(&id).unwrap();
            entry.doc.import(&update).map_err(|e| e.to_string())?;
            entry.dirty = true;
            let version = B64.encode(entry.doc.oplog_vv().encode());
            broadcast(&st, &id, Some(client), &update);
            Ok(json!({"version": version}))
        }

        "doc.close" => {
            let id = id_param(p)?;
            if let Some(entry) = state.lock().unwrap().docs.get_mut(&id) {
                entry.subscribers.remove(&client);
            }
            Ok(json!({}))
        }

        "drafts.get" => {
            let id = id_param(p)?;
            let mut st = state.lock().unwrap();
            ensure_loaded(&mut st, &id)?;
            let doc = &st.docs[&id].doc;
            Ok(json!({
                "text": doc.get_text("body").to_string(),
                "meta": serde_json::to_value(doc.get_map("meta").get_deep_value()).unwrap(),
                "version": B64.encode(doc.oplog_vv().encode()),
            }))
        }

        "drafts.setText" => {
            let id = id_param(p)?;
            let text = str_param(p, "text")?.to_string();
            agent_edit(state, &id, |doc| {
                doc.get_text("body").update(&text, UpdateOptions::default()).map_err(|e| format!("{e:?}"))
            })
        }

        "drafts.insert" => {
            let id = id_param(p)?;
            let text = str_param(p, "text")?.to_string();
            let pos = p.get("pos").and_then(Value::as_u64).ok_or("missing param pos")? as usize;
            agent_edit(state, &id, |doc| doc.get_text("body").insert_utf16(pos, &text).map_err(|e| e.to_string()))
        }

        "drafts.append" => {
            let id = id_param(p)?;
            let text = str_param(p, "text")?.to_string();
            agent_edit(state, &id, |doc| {
                let body = doc.get_text("body");
                body.insert_utf16(body.len_utf16(), &text).map_err(|e| e.to_string())
            })
        }

        "spike.create" => {
            let id = id_param(p)?;
            let text = match p.get("path").and_then(Value::as_str) {
                Some(path) => std::fs::read_to_string(path).map_err(|e| e.to_string())?,
                None => p.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            };
            let doc = LoroDoc::new();
            let meta = doc.get_map("meta");
            let now = now_ms();
            meta.insert("schema", 1).unwrap();
            meta.insert("state", "inbox").unwrap();
            meta.insert("createdAt", now).unwrap();
            meta.insert("modifiedAt", now).unwrap();
            doc.get_text("body").insert(0, &text).unwrap();
            doc.commit_with(CommitOptions::new().origin("create"));
            std::fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
            save(&id, &doc).map_err(|e| e.to_string())?;
            let mut st = state.lock().unwrap();
            let subscribers = st.docs.remove(&id).map(|d| d.subscribers).unwrap_or_default();
            st.docs.insert(id.clone(), Doc { doc, subscribers, dirty: false });
            Ok(json!({"id": id, "chars": text.len()}))
        }

        "spike.agentStorm" => {
            let id = id_param(p)?;
            let near = p.get("near").and_then(Value::as_u64).unwrap_or(0) as usize;
            let count = p.get("count").and_then(Value::as_u64).unwrap_or(20);
            let interval = p.get("intervalMs").and_then(Value::as_u64).unwrap_or(30);
            let (state, tx) = (state.clone(), tx.clone());
            tokio::spawn(async move {
                let mut rng = Rng(now_ms() as u64 | 1);
                let mut edit_ms = Vec::new();
                for _ in 0..count {
                    tokio::time::sleep(Duration::from_millis(interval)).await;
                    match agent_edit(&state, &id, |doc| storm_edit(doc, near, &mut rng)) {
                        Ok(r) => edit_ms.push(r["editMs"].as_f64().unwrap_or(0.0)),
                        Err(e) => eprintln!("storm edit failed: {e}"),
                    }
                }
                notify(&tx, "spike.stormDone", json!({"id": id, "editMs": edit_ms}));
            });
            Ok(json!({"started": true}))
        }

        "spike.stats" => {
            let id = id_param(p)?;
            let mut st = state.lock().unwrap();
            ensure_loaded(&mut st, &id)?;
            let doc = &st.docs[&id].doc;
            let snapshot = doc.export(ExportMode::Snapshot).map_err(|e| e.to_string())?;
            Ok(json!({
                "snapshotBytes": snapshot.len(),
                "textChars": doc.get_text("body").len_utf16(),
                "peers": doc.oplog_vv().len(),
                "subscribers": st.docs[&id].subscribers.len(),
            }))
        }

        "spike.shutdown" => {
            save_dirty(state);
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                std::process::exit(0);
            });
            Ok(json!({"bye": true}))
        }

        _ => Err(format!("unknown method {method}")),
    }
}

fn save_dirty(state: &Shared) {
    let mut st = state.lock().unwrap();
    for (id, entry) in st.docs.iter_mut() {
        if entry.dirty {
            if let Err(e) = save(id, &entry.doc) {
                eprintln!("save {id} failed: {e}");
            } else {
                entry.dirty = false;
            }
        }
    }
}

async fn serve(stream: UnixStream, state: Shared) {
    let (reader, mut writer) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let client = {
        let mut st = state.lock().unwrap();
        st.next_client += 1;
        let id = st.next_client;
        st.clients.insert(id, tx.clone());
        id
    };
    let write_task = tokio::spawn(async move {
        while let Some(mut line) = rx.recv().await {
            line.push('\n');
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.send(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}}).to_string());
                continue;
            }
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let reply = match handle(&state, client, &tx, method, &params) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err(message) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": message}}),
        };
        let _ = tx.send(reply.to_string());
    }

    {
        let mut st = state.lock().unwrap();
        st.clients.remove(&client);
        for entry in st.docs.values_mut() {
            entry.subscribers.remove(&client);
        }
    }
    // Let the writer drain queued replies; it ends once every sender is gone.
    drop(tx);
    let _ = write_task.await;
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let dir = runtime_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    std::fs::create_dir_all(data_dir())?;
    let sock = dir.join("daemon.sock");
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    std::fs::set_permissions(&sock, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    eprintln!("spike-daemon {} listening on {}", std::process::id(), sock.display());

    let state: Shared = Arc::default();
    let saver = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            save_dirty(&saver);
        }
    });

    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(serve(stream, state.clone()));
    }
}
