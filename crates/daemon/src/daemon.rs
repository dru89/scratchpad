//! The daemon's state and request handling. One task owns a `Daemon` and
//! feeds it every request in order, so replies and broadcasts leave in the
//! order they were produced. In particular, the reply to `doc.open` always
//! reaches a client before any `doc.update` for that draft.

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use loro::{CommitOptions, ExportMode, Frontiers, LoroDoc, UpdateOptions, VersionVector};
use scratchpad_core::attachments::{self, AddError, Attachments};
use scratchpad_core::draft;
use scratchpad_core::protocol::{self as proto, DraftDetail, DraftState, DraftSummary, EMPTY_TITLE, RpcError, codes};
use scratchpad_core::store::{IndexRow, ListQuery, Pending, Resolve, Store};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

pub type ClientId = u64;

/// Reindex a draft once edits pause for this long...
const REINDEX_IDLE_MS: i64 = 400;
/// ...or at the latest this long after the first unindexed edit.
const REINDEX_MAX_WAIT_MS: i64 = 2_000;
/// Fold a draft's update log into a snapshot past either threshold.
const COMPACT_UPDATES: usize = 500;
const COMPACT_BYTES: usize = 512 * 1024;
/// Drop a loaded draft from memory after this long with no windows open.
const UNLOAD_IDLE: Duration = Duration::from_secs(600);
pub const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Delete an attachment this long after the last draft using it stops, the
/// Trash included. Long enough that undoing a deleted image, or restoring a
/// purged draft's text from somewhere, still finds it.
pub const ATTACHMENT_RETENTION_MS: i64 = TRASH_RETENTION_MS;
const DEFAULT_LIST_LIMIT: usize = 100;

struct Client {
    tx: UnboundedSender<String>,
    ui_since: Option<u64>,
    list_subscriber: bool,
}

struct OpenDoc {
    doc: LoroDoc,
    subscribers: HashSet<ClientId>,
    pending: Pending,
    last_used: Instant,
    /// Hash of the body as last written to the search index.
    indexed_body: Option<u64>,
}

impl OpenDoc {
    fn new(doc: LoroDoc, pending: Pending) -> OpenDoc {
        OpenDoc { doc, subscribers: HashSet::new(), pending, last_used: Instant::now(), indexed_body: None }
    }
}

/// Frontiers name the same version regardless of the order of their ids.
fn same_version(a: &Frontiers, b: &Frontiers) -> bool {
    let mut a: Vec<_> = a.iter().collect();
    let mut b: Vec<_> = b.iter().collect();
    a.sort();
    b.sort();
    a == b
}

fn decode_version(v: &str, name: &str) -> Result<Frontiers, RpcError> {
    let bytes = B64.decode(v).map_err(|e| RpcError::invalid_params(format!("bad {name}: {e}")))?;
    Frontiers::decode(&bytes).map_err(|e| RpcError::invalid_params(format!("bad {name}: {e}")))
}

fn hash_text(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

struct Dirty {
    first: i64,
    last: i64,
}

pub struct Daemon {
    store: Store,
    attachments: Attachments,
    clients: HashMap<ClientId, Client>,
    docs: HashMap<String, OpenDoc>,
    dirty: HashMap<String, Dirty>,
    clock: Box<dyn Fn() -> i64 + Send>,
    started: Instant,
    ui_counter: u64,
    pub shutdown_requested: bool,
}

pub fn wall_clock() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn params<T: DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::invalid_params(e.to_string()))
}

fn internal(e: impl std::fmt::Display) -> RpcError {
    RpcError::internal(e)
}

fn summary_from_doc(id: &str, doc: &LoroDoc) -> DraftSummary {
    let (row, _) = IndexRow::from_doc(doc);
    DraftSummary {
        id: id.to_string(),
        title: if row.title.is_empty() { EMPTY_TITLE.to_string() } else { row.title },
        state: row.state,
        created_at: row.created_at,
        modified_at: row.modified_at,
        trashed_at: row.trashed_at,
        preview: row.preview,
        snippet: None,
    }
}

impl Daemon {
    pub fn new(store: Store, attachments: Attachments, clock: Box<dyn Fn() -> i64 + Send>) -> anyhow::Result<Daemon> {
        let mut daemon = Daemon {
            store,
            attachments,
            clients: HashMap::new(),
            docs: HashMap::new(),
            dirty: HashMap::new(),
            clock,
            started: Instant::now(),
            ui_counter: 0,
            shutdown_requested: false,
        };
        daemon.repair_index()?;
        Ok(daemon)
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Rebuilds the index if it has drifted from the stored documents, for
    /// example after a crash between writing a draft and indexing it, or
    /// after a schema upgrade added a column.
    fn repair_index(&mut self) -> anyhow::Result<()> {
        let ids = self.store.all_ids()?;
        if self.store.indexed_count()? as usize == ids.len() && !self.store.index_needs_refresh() {
            return Ok(());
        }
        for id in ids {
            if let Some((doc, _)) = self.store.load_doc(&id)? {
                let (row, body) = IndexRow::from_doc(&doc);
                self.store.upsert_index(&id, &row, Some(&body))?;
            }
        }
        Ok(())
    }

    // ---- connections ----------------------------------------------------

    pub fn connect(&mut self, id: ClientId, tx: UnboundedSender<String>) {
        self.clients.insert(id, Client { tx, ui_since: None, list_subscriber: false });
    }

    pub fn disconnect(&mut self, id: ClientId) {
        self.clients.remove(&id);
        for open in self.docs.values_mut() {
            open.subscribers.remove(&id);
        }
    }

    fn send(&self, client: ClientId, line: String) {
        if let Some(c) = self.clients.get(&client) {
            let _ = c.tx.send(line);
        }
    }

    fn notify_list(&self, method: &str, params: Value) {
        let line = proto::notification(method, params);
        for c in self.clients.values().filter(|c| c.list_subscriber) {
            let _ = c.tx.send(line.clone());
        }
    }

    /// Handles one line from a client and queues the reply.
    pub fn handle_line(&mut self, client: ClientId, line: &str) {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let err = RpcError::new(codes::PARSE_ERROR, e.to_string());
                return self.send(client, proto::response(Value::Null, Err(err)));
            }
        };
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            let err = RpcError::new(codes::INVALID_REQUEST, "missing method");
            return self.send(client, proto::response(msg.get("id").cloned().unwrap_or(Value::Null), Err(err)));
        };
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = self.dispatch(client, method, params);
        // Requests without an id are notifications: no reply.
        if let Some(id) = msg.get("id").cloned() {
            self.send(client, proto::response(id, result));
        }
    }

    fn dispatch(&mut self, client: ClientId, method: &str, p: Value) -> Result<Value, RpcError> {
        match method {
            "hello" => self.hello(client, params(p)?),
            "daemon.status" => Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "pid": std::process::id(),
                "uptimeSec": self.started.elapsed().as_secs(),
                "clients": self.clients.len(),
                "openDocs": self.docs.len(),
                "drafts": self.store.indexed_count().map_err(internal)?,
            })),
            "daemon.shutdown" => {
                self.shutdown_requested = true;
                Ok(json!({}))
            }
            "drafts.list" => self.list(params(p)?),
            "drafts.get" => self.get(params(p)?),
            "drafts.create" => self.create(params(p)?),
            "drafts.setText" => {
                let proto::SetTextParams { id, text, base_version } = params(p)?;
                match base_version {
                    Some(base) => self.set_text_from(&id, &base, &text),
                    None => {
                        let mut v = self.agent_edit(&id, |doc| {
                            draft::body(doc)
                                .update(&text, UpdateOptions::default())
                                .map_err(|e| internal(format!("{e:?}")))
                        })?;
                        v["merged"] = json!(false);
                        Ok(v)
                    }
                }
            }
            "drafts.append" => {
                let proto::AppendParams { id, text, ensure_newline } = params(p)?;
                self.agent_edit(&id, |doc| {
                    let body = draft::body(doc);
                    let ends_open = !body.to_string().is_empty() && !body.to_string().ends_with('\n');
                    let text =
                        if ensure_newline && ends_open && !text.starts_with('\n') { format!("\n{text}") } else { text };
                    body.insert_utf16(body.len_utf16(), &text).map_err(internal)
                })
            }
            "drafts.setState" => self.set_state(params(p)?),
            "drafts.discard" => self.discard(params(p)?),
            "drafts.emptyTrash" => self.empty_trash(),
            "drafts.export" => self.export(params(p)?),
            "drafts.render" => self.render(params(p)?),
            "attachments.add" => {
                let proto::AddAttachmentParams { data } = params(p)?;
                let bytes = B64.decode(data).map_err(|e| RpcError::invalid_params(format!("bad data: {e}")))?;
                let name = self.attachments.add(&bytes).map_err(|e| match e {
                    AddError::Io(e) => internal(e),
                    e => RpcError::invalid_params(e.to_string()),
                })?;
                Ok(json!({ "name": name, "size": bytes.len() }))
            }
            "attachments.get" => {
                let proto::AttachmentParams { name } = params(p)?;
                match self.attachments.read(&name).map_err(internal)? {
                    Some((kind, bytes)) => Ok(json!({ "name": name, "type": kind.mime(), "data": B64.encode(bytes) })),
                    None => Err(RpcError::new(codes::NOT_FOUND, format!("no attachment {name}"))),
                }
            }
            "drafts.subscribe" | "drafts.unsubscribe" => {
                if let Some(c) = self.clients.get_mut(&client) {
                    c.list_subscriber = method == "drafts.subscribe";
                }
                Ok(json!({}))
            }
            "doc.open" => self.doc_open(client, params(p)?),
            "doc.push" => self.doc_push(client, params(p)?),
            "doc.close" => {
                let proto::IdParams { id } = params(p)?;
                let id = self.resolve(&id)?;
                if let Some(open) = self.docs.get_mut(&id) {
                    open.subscribers.remove(&client);
                }
                Ok(json!({}))
            }
            "ui.capture" => {
                let mut p: proto::CaptureParams = params(p)?;
                if let Some(id) = p.draft_id.take() {
                    p.draft_id = Some(self.resolve(&id)?);
                }
                self.forward_to_app("ui.capture", serde_json::to_value(p).unwrap())
            }
            "ui.open" => {
                let proto::IdParams { id } = params(p)?;
                let id = self.resolve(&id)?;
                self.forward_to_app("ui.open", json!({ "id": id }))
            }
            _ => Err(RpcError::new(codes::METHOD_NOT_FOUND, format!("unknown method {method}"))),
        }
    }

    fn hello(&mut self, client: ClientId, hello: proto::Hello) -> Result<Value, RpcError> {
        if hello.capabilities.iter().any(|c| c == "ui") {
            self.ui_counter += 1;
            let n = self.ui_counter;
            if let Some(c) = self.clients.get_mut(&client) {
                c.ui_since = Some(n);
            }
        }
        Ok(serde_json::to_value(proto::HelloResult {
            protocol: proto::PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
        })
        .unwrap())
    }

    /// Sends a UI command to the most recently connected app.
    fn forward_to_app(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let app = self.clients.values().filter(|c| c.ui_since.is_some()).max_by_key(|c| c.ui_since);
        // Once the app exists, the daemon will launch it here instead.
        let Some(app) = app else {
            return Err(RpcError::new(codes::NO_APP, "the scratchpad app isn't running"));
        };
        let _ = app.tx.send(proto::notification(method, params));
        Ok(json!({ "delivered": true }))
    }

    // ---- drafts ---------------------------------------------------------

    fn resolve(&self, raw: &str) -> Result<String, RpcError> {
        match self.store.resolve(raw).map_err(internal)? {
            Resolve::Found(id) => Ok(id),
            Resolve::NotFound => Err(RpcError::new(codes::NOT_FOUND, format!("no draft matches {raw}"))),
            Resolve::Ambiguous(ids) => {
                Err(RpcError::new(codes::AMBIGUOUS_ID, format!("{raw} matches more than one draft"))
                    .with_data(json!({ "candidates": ids })))
            }
        }
    }

    fn load(&mut self, id: &str) -> Result<&mut OpenDoc, RpcError> {
        if !self.docs.contains_key(id) {
            let (doc, pending) = self
                .store
                .load_doc(id)
                .map_err(internal)?
                .ok_or_else(|| RpcError::new(codes::NOT_FOUND, format!("no draft {id}")))?;
            self.docs.insert(id.to_string(), OpenDoc::new(doc, pending));
        }
        let open = self.docs.get_mut(id).unwrap();
        open.last_used = Instant::now();
        Ok(open)
    }

    fn list(&mut self, p: proto::ListParams) -> Result<Value, RpcError> {
        self.flush_dirty(true);
        let q = ListQuery {
            states: p.states.unwrap_or_default(),
            query: p.query.filter(|q| !q.trim().is_empty()),
            limit: p.limit.unwrap_or(DEFAULT_LIST_LIMIT),
            cursor: p.cursor,
        };
        let (drafts, next_cursor) = self.store.list(&q).map_err(|e| RpcError::invalid_params(e.to_string()))?;
        Ok(serde_json::to_value(proto::ListResult { drafts, next_cursor }).unwrap())
    }

    fn get(&mut self, p: proto::GetParams) -> Result<Value, RpcError> {
        let id = self.resolve(&p.id)?;
        let known = p.known_version.as_deref().map(|v| decode_version(v, "knownVersion")).transpose()?;
        let open = self.load(&id)?;
        if known.is_some_and(|k| same_version(&k, &open.doc.oplog_frontiers())) {
            let mut v = serde_json::to_value(summary_from_doc(&id, &open.doc)).unwrap();
            v["unchanged"] = json!(true);
            v["version"] = json!(B64.encode(open.doc.oplog_frontiers().encode()));
            return Ok(v);
        }
        let detail = DraftDetail {
            summary: summary_from_doc(&id, &open.doc),
            text: draft::body(&open.doc).to_string(),
            meta: draft::meta_json(&open.doc),
            version: B64.encode(open.doc.oplog_frontiers().encode()),
        };
        Ok(serde_json::to_value(detail).unwrap())
    }

    fn create(&mut self, p: proto::CreateParams) -> Result<Value, RpcError> {
        let now = self.now();
        let id = ulid::Ulid::generate().to_string();
        let doc = draft::new_doc(&p.text, p.state.unwrap_or(DraftState::Inbox), now);
        self.store.insert_doc(&id, &doc, now).map_err(internal)?;
        self.docs.insert(id.clone(), OpenDoc::new(doc, Pending::default()));
        self.reindex(&id)?;
        self.summary_value(&id)
    }

    /// The draft's summary plus its current version, for chaining edits.
    fn summary_value(&self, id: &str) -> Result<Value, RpcError> {
        let open = self.docs.get(id).ok_or_else(|| internal("draft not loaded"))?;
        let mut v = serde_json::to_value(summary_from_doc(id, &open.doc)).unwrap();
        v["version"] = json!(B64.encode(open.doc.oplog_frontiers().encode()));
        Ok(v)
    }

    /// setText against the version the caller read: the diff is computed on
    /// a fork at that version, then merged, so text written since is kept.
    /// The result's `merged` says whether anything else had been written
    /// since, in which case the caller's copy of the text is out of date.
    fn set_text_from(&mut self, raw: &str, base: &str, text: &str) -> Result<Value, RpcError> {
        let id = self.resolve(raw)?;
        let now = self.now();
        let frontiers = decode_version(base, "baseVersion")?;
        let open = self.load(&id)?;
        let merged = !same_version(&frontiers, &open.doc.oplog_frontiers());
        let fork = open
            .doc
            .fork_at(&frontiers)
            .map_err(|_| RpcError::invalid_params("baseVersion isn't part of this draft's history"))?;
        // Never let the fork share a peer id with the daemon's copy.
        fork.set_peer_id(ulid::Ulid::generate().random() as u64 & (u64::MAX >> 1)).map_err(internal)?;
        let base_vv = fork.oplog_vv();
        draft::body(&fork).update(text, UpdateOptions::default()).map_err(|e| internal(format!("{e:?}")))?;
        draft::stamp_modified(&fork, now);
        fork.commit_with(CommitOptions::new().origin("agent"));
        let update = fork.export(ExportMode::updates(&base_vv)).map_err(internal)?;
        open.doc.import(&update).map_err(internal)?;
        self.record_change(&id, &update, None)?;
        let mut v = self.summary_value(&id)?;
        v["merged"] = json!(merged);
        Ok(v)
    }

    /// Applies an edit as the daemon's own peer (the CLI or an agent), then
    /// stores it and relays it to open windows.
    fn agent_edit(&mut self, raw: &str, f: impl FnOnce(&LoroDoc) -> Result<(), RpcError>) -> Result<Value, RpcError> {
        let id = self.resolve(raw)?;
        let now = self.now();
        let open = self.load(&id)?;
        let before = open.doc.oplog_vv();
        f(&open.doc)?;
        draft::stamp_modified(&open.doc, now);
        open.doc.commit_with(CommitOptions::new().origin("agent"));
        let update = open.doc.export(ExportMode::updates(&before)).map_err(internal)?;
        self.record_change(&id, &update, None)?;
        self.summary_value(&id)
    }

    fn set_state(&mut self, p: proto::SetStateParams) -> Result<Value, RpcError> {
        let id = self.resolve(&p.id)?;
        let now = self.now();
        let open = self.load(&id)?;
        let before = open.doc.oplog_vv();
        draft::set_state(&open.doc, p.state, now);
        let update = open.doc.export(ExportMode::updates(&before)).map_err(internal)?;
        self.record_change(&id, &update, None)?;
        self.reindex(&id)?;
        self.summary_value(&id)
    }

    fn discard(&mut self, p: proto::IdParams) -> Result<Value, RpcError> {
        let id = self.resolve(&p.id)?;
        if !draft::is_blank(&self.load(&id)?.doc) {
            return Err(RpcError::new(codes::NOT_EMPTY, "only empty drafts can be discarded; trash it instead"));
        }
        self.delete(&id)?;
        Ok(json!({ "id": id }))
    }

    /// Deletes everything in the Trash now: the app's Empty Trash.
    fn empty_trash(&mut self) -> Result<Value, RpcError> {
        self.flush_dirty(true);
        let ids = self.store.trashed_before(i64::MAX).map_err(internal)?;
        for id in &ids {
            self.delete(id)?;
        }
        Ok(json!({ "deleted": ids.len() }))
    }

    /// Writes every draft as markdown to a folder or a zip
    /// (scratchpad_core::export), or with `id`, one draft and its images.
    /// Open drafts come from memory, so the export has the latest typing.
    fn export(&mut self, p: proto::ExportParams) -> Result<Value, RpcError> {
        let path = std::path::PathBuf::from(&p.path);
        if !path.is_absolute() {
            return Err(RpcError::invalid_params("the export path has to be absolute"));
        }
        self.flush_dirty(true);
        let (entries, count) = match &p.id {
            Some(id) => {
                let id = self.resolve(id)?;
                let body = draft::body(&self.load(&id)?.doc).to_string();
                let summary =
                    self.store.summary(&id).map_err(internal)?.ok_or_else(|| internal("draft not indexed"))?;
                (scratchpad_core::export::draft_entries(&summary, &body, &self.attachments, self.now()), 1)
            }
            None => {
                let mut drafts = Vec::new();
                for summary in self.store.all_summaries().map_err(internal)? {
                    let body = match self.docs.get(&summary.id) {
                        Some(open) => draft::body(&open.doc).to_string(),
                        None => match self.store.load_doc(&summary.id).map_err(internal)? {
                            Some((doc, _)) => draft::body(&doc).to_string(),
                            None => continue,
                        },
                    };
                    drafts.push((summary, body));
                }
                let by = format!("scratchpad {}", env!("CARGO_PKG_VERSION"));
                (scratchpad_core::export::entries(&drafts, &self.attachments, self.now(), &by), drafts.len())
            }
        };
        let written = if p.zip {
            scratchpad_core::export::write_zip(&entries, &path, p.overwrite)
        } else {
            scratchpad_core::export::write_dir(&entries, &path)
        };
        written.map_err(|e| RpcError::new(codes::INTERNAL, format!("{e:#}")))?;
        Ok(json!({ "drafts": count, "path": p.path }))
    }

    fn render(&mut self, p: proto::RenderParams) -> Result<Value, RpcError> {
        let markdown = match (p.text, p.id) {
            (Some(text), _) => text,
            (None, Some(id)) => {
                let id = self.resolve(&id)?;
                draft::body(&self.load(&id)?.doc).to_string()
            }
            (None, None) => return Err(RpcError::invalid_params("pass id or text")),
        };
        let store = &self.attachments;
        let html = scratchpad_core::render::to_html_with(&markdown, |name| store.read(name).ok().flatten());
        Ok(json!({ "html": html }))
    }

    /// Deletes a draft outright, leaving a tombstone.
    fn delete(&mut self, id: &str) -> Result<(), RpcError> {
        let now = self.now();
        self.store.delete(id, now).map_err(internal)?;
        self.dirty.remove(id);
        if let Some(open) = self.docs.remove(id) {
            for client in open.subscribers {
                self.send(client, proto::notification("doc.removed", json!({ "id": id })));
            }
        }
        self.notify_list("drafts.removed", json!({ "id": id }));
        Ok(())
    }

    // ---- documents ------------------------------------------------------

    fn doc_open(&mut self, client: ClientId, p: proto::DocOpenParams) -> Result<Value, RpcError> {
        let id = self.resolve(&p.id)?;
        let open = self.load(&id)?;
        open.subscribers.insert(client);
        let data = match p.version {
            Some(v) => {
                let bytes = B64.decode(v).map_err(|e| RpcError::invalid_params(e.to_string()))?;
                let vv = VersionVector::decode(&bytes).map_err(|e| RpcError::invalid_params(e.to_string()))?;
                open.doc.export(ExportMode::updates(&vv))
            }
            None => open.doc.export(ExportMode::Snapshot),
        }
        .map_err(internal)?;
        Ok(serde_json::to_value(proto::DocOpenResult {
            data: B64.encode(data),
            version: B64.encode(open.doc.oplog_vv().encode()),
        })
        .unwrap())
    }

    fn doc_push(&mut self, client: ClientId, p: proto::DocPushParams) -> Result<Value, RpcError> {
        let id = self.resolve(&p.id)?;
        let update = B64.decode(&p.update).map_err(|e| RpcError::invalid_params(e.to_string()))?;
        let open = self.load(&id)?;
        let before = open.doc.oplog_vv();
        open.doc.import(&update).map_err(|e| RpcError::invalid_params(format!("bad update: {e}")))?;
        let changed = open.doc.oplog_vv() != before;
        let version = B64.encode(open.doc.oplog_vv().encode());
        // A reconnecting window may resend history the daemon already has.
        if changed {
            self.record_change(&id, &update, Some(client))?;
        }
        Ok(json!({ "version": version }))
    }

    /// Persists an update, relays it to the draft's other windows, and
    /// schedules a reindex.
    fn record_change(&mut self, id: &str, update: &[u8], from: Option<ClientId>) -> Result<(), RpcError> {
        let now = self.now();
        self.store.append_update(id, update).map_err(internal)?;
        let open = self.docs.get_mut(id).ok_or_else(|| internal("draft not loaded"))?;
        open.pending.updates += 1;
        open.pending.bytes += update.len();
        if open.pending.updates >= COMPACT_UPDATES || open.pending.bytes >= COMPACT_BYTES {
            self.store.compact(id, &open.doc, now).map_err(internal)?;
            open.pending = Pending::default();
        }
        let line = proto::notification("doc.update", json!({ "id": id, "update": B64.encode(update) }));
        for client in open.subscribers.iter().filter(|c| Some(**c) != from) {
            if let Some(c) = self.clients.get(client) {
                let _ = c.tx.send(line.clone());
            }
        }
        self.dirty.entry(id.to_string()).and_modify(|d| d.last = now).or_insert(Dirty { first: now, last: now });
        Ok(())
    }

    fn reindex(&mut self, id: &str) -> Result<(), RpcError> {
        self.dirty.remove(id);
        let Some(open) = self.docs.get_mut(id) else { return Ok(()) };
        let (row, body) = IndexRow::from_doc(&open.doc);
        let hash = hash_text(&body);
        let body_changed = open.indexed_body != Some(hash);
        open.indexed_body = Some(hash);
        self.store.upsert_index(id, &row, body_changed.then_some(body.as_str())).map_err(internal)?;
        if let Some(summary) = self.store.summary(id).map_err(internal)? {
            self.notify_list("drafts.changed", serde_json::to_value(summary).unwrap());
        }
        Ok(())
    }

    /// Reindexes drafts whose edits have settled, or all of them when `all`.
    pub fn flush_dirty(&mut self, all: bool) {
        let now = self.now();
        let due: Vec<String> = self
            .dirty
            .iter()
            .filter(|(_, d)| all || now - d.last >= REINDEX_IDLE_MS || now - d.first >= REINDEX_MAX_WAIT_MS)
            .map(|(id, _)| id.clone())
            .collect();
        for id in due {
            if let Err(e) = self.reindex(&id) {
                eprintln!("scratchpadd: reindex {id} failed: {e}");
            }
        }
    }

    /// Periodic housekeeping: settle the index and unload idle drafts.
    pub fn tick(&mut self) {
        self.flush_dirty(false);
        let idle: Vec<String> = self
            .docs
            .iter()
            .filter(|(id, o)| {
                o.subscribers.is_empty() && o.last_used.elapsed() > UNLOAD_IDLE && !self.dirty.contains_key(*id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            self.docs.remove(&id);
        }
    }

    /// Deletes drafts that have been in the Trash longer than the retention.
    pub fn purge(&mut self) {
        self.flush_dirty(true);
        let cutoff = self.now() - TRASH_RETENTION_MS;
        match self.store.trashed_before(cutoff) {
            Ok(ids) => {
                for id in ids {
                    if let Err(e) = self.delete(&id) {
                        eprintln!("scratchpadd: purge {id} failed: {e}");
                    }
                }
            }
            Err(e) => eprintln!("scratchpadd: purge failed: {e}"),
        }
        if let Err(e) = self.collect_attachments() {
            eprintln!("scratchpadd: cleaning up attachments failed: {e:#}");
        }
    }

    /// Deletes attachments no draft has used for ATTACHMENT_RETENTION_MS.
    /// The first sweep that finds one unused notes the time; a later one
    /// deletes it, unless a draft has started using it again.
    fn collect_attachments(&mut self) -> anyhow::Result<()> {
        let stored = self.attachments.list()?;
        let orphans = self.store.attachment_orphans()?;
        if stored.is_empty() && orphans.is_empty() {
            return Ok(());
        }
        let bodies = self.store.all_bodies()?;
        let used: HashSet<&str> = bodies.iter().flat_map(|b| attachments::references(b)).collect();
        let now = self.now();
        for name in &stored {
            match (used.contains(name.as_str()), orphans.get(name)) {
                (true, Some(_)) => self.store.clear_attachment_orphan(name)?,
                (false, None) => self.store.set_attachment_orphan(name, now)?,
                (false, Some(&since)) if now - since >= ATTACHMENT_RETENTION_MS => {
                    self.attachments.remove(name)?;
                    self.store.clear_attachment_orphan(name)?;
                }
                _ => {}
            }
        }
        for name in orphans.keys().filter(|n| !stored.contains(n)) {
            self.store.clear_attachment_orphan(name)?;
        }
        self.attachments.remove_partials();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};
    use tokio::sync::mpsc::{self, UnboundedReceiver};

    struct Harness {
        daemon: Daemon,
        clock: Arc<AtomicI64>,
        next_id: u64,
        _dir: tempfile::TempDir,
    }

    struct TestClient {
        id: ClientId,
        rx: UnboundedReceiver<String>,
    }

    impl Harness {
        fn new() -> Harness {
            let clock = Arc::new(AtomicI64::new(1_000_000));
            let c = clock.clone();
            let dir = tempfile::tempdir().unwrap();
            let attachments = Attachments::new(dir.path().join("attachments"));
            let daemon =
                Daemon::new(Store::open_in_memory().unwrap(), attachments, Box::new(move || c.load(Ordering::SeqCst)))
                    .unwrap();
            Harness { daemon, clock, next_id: 0, _dir: dir }
        }

        fn client(&mut self) -> TestClient {
            self.next_id += 1;
            let (tx, rx) = mpsc::unbounded_channel();
            self.daemon.connect(self.next_id, tx);
            TestClient { id: self.next_id, rx }
        }

        fn advance(&self, ms: i64) {
            self.clock.fetch_add(ms, Ordering::SeqCst);
        }

        /// Sends a request and returns (result or error, notifications that arrived before the reply).
        fn call(&mut self, c: &mut TestClient, method: &str, params: Value) -> (Result<Value, RpcError>, Vec<Value>) {
            self.daemon.handle_line(c.id, &proto::request(1, method, params));
            let mut notes = Vec::new();
            while let Ok(line) = c.rx.try_recv() {
                let v: Value = serde_json::from_str(&line).unwrap();
                if v.get("id").is_some() {
                    let result = match v.get("error") {
                        Some(e) => Err(serde_json::from_value(e.clone()).unwrap()),
                        None => Ok(v["result"].clone()),
                    };
                    return (result, notes);
                }
                notes.push(v);
            }
            panic!("no reply to {method}");
        }

        fn ok(&mut self, c: &mut TestClient, method: &str, params: Value) -> Value {
            self.call(c, method, params).0.unwrap_or_else(|e| panic!("{method} failed: {e}"))
        }
    }

    fn drain(c: &mut TestClient) -> Vec<Value> {
        std::iter::from_fn(|| c.rx.try_recv().ok()).map(|l| serde_json::from_str(&l).unwrap()).collect()
    }

    fn titles(v: &Value) -> Vec<String> {
        v["drafts"].as_array().unwrap().iter().map(|d| d["title"].as_str().unwrap().to_string()).collect()
    }

    /// A window's Loro copy, opened through the protocol.
    fn open_window(h: &mut Harness, c: &mut TestClient, id: &str) -> LoroDoc {
        let r = h.ok(c, "doc.open", json!({ "id": id }));
        let doc = LoroDoc::new();
        doc.import(&B64.decode(r["data"].as_str().unwrap()).unwrap()).unwrap();
        doc
    }

    fn push(h: &mut Harness, c: &mut TestClient, id: &str, doc: &LoroDoc, edit: impl FnOnce(&LoroDoc)) {
        let before = doc.oplog_vv();
        edit(doc);
        doc.commit();
        let update = doc.export(ExportMode::updates(&before)).unwrap();
        h.ok(c, "doc.push", json!({ "id": id, "update": B64.encode(update) }));
    }

    fn apply_updates(doc: &LoroDoc, notes: &[Value]) {
        for n in notes.iter().filter(|n| n["method"] == "doc.update") {
            doc.import(&B64.decode(n["params"]["update"].as_str().unwrap()).unwrap()).unwrap();
        }
    }

    #[test]
    fn create_list_get_and_titles() {
        let mut h = Harness::new();
        let mut c = h.client();
        let a = h.ok(&mut c, "drafts.create", json!({ "text": "# First\n\nbody" }));
        assert_eq!(a["title"], "First");
        h.advance(10);
        h.ok(&mut c, "drafts.create", json!({ "text": "" }));
        let list = h.ok(&mut c, "drafts.list", json!({}));
        assert_eq!(titles(&list), ["New draft", "First"]);
        let got = h.ok(&mut c, "drafts.get", json!({ "id": &a["id"].as_str().unwrap()[..20] }));
        assert_eq!(got["text"], "# First\n\nbody");
        assert_eq!(got["meta"]["schema"], 1);
    }

    #[test]
    fn agent_set_text_merges_with_window_typing() {
        let mut h = Harness::new();
        let mut agent = h.client();
        let mut win = h.client();
        let id = h.ok(&mut agent, "drafts.create", json!({ "text": "alpha beta gamma" }))["id"]
            .as_str()
            .unwrap()
            .to_string();
        let doc = open_window(&mut h, &mut win, &id);

        // The agent reads, the window types at the end, then the agent writes
        // its revision of what it read.
        let base = h.ok(&mut agent, "drafts.get", json!({ "id": id }))["version"].clone();
        push(&mut h, &mut win, &id, &doc, |d| draft::body(d).insert(16, " delta").unwrap());
        let r =
            h.ok(&mut agent, "drafts.setText", json!({ "id": id, "text": "alpha BETA gamma", "baseVersion": base }));
        assert_eq!(r["merged"], true, "the window's typing was merged in");
        apply_updates(&doc, &drain(&mut win));

        let daemon_text = h.ok(&mut agent, "drafts.get", json!({ "id": id }))["text"].clone();
        assert_eq!(daemon_text, "alpha BETA gamma delta");
        assert_eq!(draft::body(&doc).to_string(), "alpha BETA gamma delta");
    }

    #[test]
    fn an_uncontested_edit_reports_no_merge_and_can_be_chained() {
        let mut h = Harness::new();
        let mut agent = h.client();
        let id = h.ok(&mut agent, "drafts.create", json!({ "text": "one" }))["id"].as_str().unwrap().to_string();
        let base = h.ok(&mut agent, "drafts.get", json!({ "id": id }))["version"].clone();
        let r = h.ok(&mut agent, "drafts.setText", json!({ "id": id, "text": "one two", "baseVersion": base }));
        assert_eq!(r["merged"], false);
        // Nothing else happened, so the returned version goes with the text we sent.
        let r = h.ok(
            &mut agent,
            "drafts.setText",
            json!({ "id": id, "text": "one two three", "baseVersion": r["version"] }),
        );
        assert_eq!(r["merged"], false);
        assert_eq!(h.ok(&mut agent, "drafts.get", json!({ "id": id }))["text"], "one two three");
    }

    #[test]
    fn get_with_a_known_version_skips_the_text_when_unchanged() {
        let mut h = Harness::new();
        let mut c = h.client();
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "stable" }))["id"].as_str().unwrap().to_string();
        let v = h.ok(&mut c, "drafts.get", json!({ "id": id }))["version"].clone();
        let same = h.ok(&mut c, "drafts.get", json!({ "id": id, "knownVersion": v }));
        assert_eq!(same["unchanged"], true);
        assert!(same.get("text").is_none());
        h.ok(&mut c, "drafts.append", json!({ "id": id, "text": "!" }));
        let changed = h.ok(&mut c, "drafts.get", json!({ "id": id, "knownVersion": v }));
        assert!(changed.get("unchanged").is_none());
        assert_eq!(changed["text"], "stable!");
    }

    #[test]
    fn set_text_without_a_base_replaces_current_text() {
        let mut h = Harness::new();
        let mut agent = h.client();
        let mut win = h.client();
        let id = h.ok(&mut agent, "drafts.create", json!({ "text": "alpha" }))["id"].as_str().unwrap().to_string();
        let doc = open_window(&mut h, &mut win, &id);
        push(&mut h, &mut win, &id, &doc, |d| draft::body(d).insert(5, " typed").unwrap());
        h.ok(&mut agent, "drafts.setText", json!({ "id": id, "text": "replaced" }));
        assert_eq!(h.ok(&mut agent, "drafts.get", json!({ "id": id }))["text"], "replaced");
    }

    #[test]
    fn a_bad_base_version_is_rejected() {
        let mut h = Harness::new();
        let mut c = h.client();
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "x" }))["id"].as_str().unwrap().to_string();
        let other = draft::new_doc("y", DraftState::Inbox, 1);
        let foreign = B64.encode(other.oplog_frontiers().encode());
        let (r, _) = h.call(&mut c, "drafts.setText", json!({ "id": id, "text": "z", "baseVersion": foreign }));
        assert_eq!(r.unwrap_err().code, codes::INVALID_PARAMS);
        assert_eq!(h.ok(&mut c, "drafts.get", json!({ "id": id }))["text"], "x");
    }

    #[test]
    fn pushes_are_relayed_to_other_windows_only() {
        let mut h = Harness::new();
        let mut a = h.client();
        let mut b = h.client();
        let id = h.ok(&mut a, "drafts.create", json!({ "text": "x" }))["id"].as_str().unwrap().to_string();
        let doc_a = open_window(&mut h, &mut a, &id);
        let doc_b = open_window(&mut h, &mut b, &id);
        push(&mut h, &mut a, &id, &doc_a, |d| draft::body(d).insert(1, "yz").unwrap());
        assert!(drain(&mut a).is_empty(), "sender shouldn't get its own update back");
        apply_updates(&doc_b, &drain(&mut b));
        assert_eq!(draft::body(&doc_b).to_string(), "xyz");
    }

    #[test]
    fn repeated_pushes_are_not_stored_twice() {
        let mut h = Harness::new();
        let mut w = h.client();
        let mut other = h.client();
        let id = h.ok(&mut w, "drafts.create", json!({ "text": "x" }))["id"].as_str().unwrap().to_string();
        let doc = open_window(&mut h, &mut w, &id);
        open_window(&mut h, &mut other, &id);
        let before = doc.oplog_vv();
        draft::body(&doc).insert(1, "!").unwrap();
        doc.commit();
        let update = B64.encode(doc.export(ExportMode::updates(&before)).unwrap());
        h.ok(&mut w, "doc.push", json!({ "id": id, "update": update }));
        h.ok(&mut w, "doc.push", json!({ "id": id, "update": update }));
        assert_eq!(drain(&mut other).len(), 1);
    }

    #[test]
    fn window_edits_reach_the_index_before_a_list() {
        let mut h = Harness::new();
        let mut w = h.client();
        let id = h.ok(&mut w, "drafts.create", json!({ "text": "" }))["id"].as_str().unwrap().to_string();
        let doc = open_window(&mut h, &mut w, &id);
        push(&mut h, &mut w, &id, &doc, |d| draft::body(d).insert(0, "# Typed title").unwrap());
        let list = h.ok(&mut w, "drafts.list", json!({ "query": "typed" }));
        assert_eq!(titles(&list), ["Typed title"]);
    }

    #[test]
    fn index_settles_after_a_pause_and_notifies_subscribers() {
        let mut h = Harness::new();
        let mut w = h.client();
        let mut sidebar = h.client();
        h.ok(&mut sidebar, "drafts.subscribe", json!({}));
        let id = h.ok(&mut w, "drafts.create", json!({ "text": "" }))["id"].as_str().unwrap().to_string();
        drain(&mut sidebar);
        let doc = open_window(&mut h, &mut w, &id);
        push(&mut h, &mut w, &id, &doc, |d| draft::body(d).insert(0, "Settled").unwrap());
        h.daemon.tick();
        assert!(drain(&mut sidebar).is_empty(), "too soon to reindex");
        h.advance(REINDEX_IDLE_MS);
        h.daemon.tick();
        let notes = drain(&mut sidebar);
        assert_eq!(notes[0]["method"], "drafts.changed");
        assert_eq!(notes[0]["params"]["title"], "Settled");
    }

    #[test]
    fn trash_purges_after_retention_and_leaves_a_tombstone() {
        let mut h = Harness::new();
        let mut c = h.client();
        let mut sidebar = h.client();
        h.ok(&mut sidebar, "drafts.subscribe", json!({}));
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "doomed" }))["id"].as_str().unwrap().to_string();
        let s = h.ok(&mut c, "drafts.setState", json!({ "id": id, "state": "trashed" }));
        assert_eq!(s["state"], "trashed");
        h.advance(TRASH_RETENTION_MS - 1);
        h.daemon.purge();
        assert!(h.call(&mut c, "drafts.get", json!({ "id": id })).0.is_ok());
        h.advance(2);
        drain(&mut sidebar);
        h.daemon.purge();
        let (r, _) = h.call(&mut c, "drafts.get", json!({ "id": id }));
        assert_eq!(r.unwrap_err().code, codes::NOT_FOUND);
        assert!(h.daemon.store.is_tombstoned(&id).unwrap());
        assert!(drain(&mut sidebar).iter().any(|n| n["method"] == "drafts.removed"));
    }

    #[test]
    fn restore_returns_to_inbox_without_reordering() {
        let mut h = Harness::new();
        let mut c = h.client();
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "x" }))["id"].as_str().unwrap().to_string();
        let created = h.ok(&mut c, "drafts.get", json!({ "id": id }))["modifiedAt"].clone();
        h.advance(1000);
        h.ok(&mut c, "drafts.setState", json!({ "id": id, "state": "trashed" }));
        let r = h.ok(&mut c, "drafts.setState", json!({ "id": id, "state": "inbox" }));
        assert_eq!(r["state"], "inbox");
        assert!(r.get("trashedAt").is_none());
        assert_eq!(r["modifiedAt"], created);
    }

    #[test]
    fn state_changes_keep_the_draft_searchable() {
        let mut h = Harness::new();
        let mut c = h.client();
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "# Title\n\nfindable words" }))["id"]
            .as_str()
            .unwrap()
            .to_string();
        h.ok(&mut c, "drafts.setState", json!({ "id": id, "state": "archived" }));
        let hits = h.ok(&mut c, "drafts.list", json!({ "states": ["archived"], "query": "findable" }));
        assert_eq!(titles(&hits), ["Title"]);
    }

    #[test]
    fn append_can_start_a_new_line() {
        let mut h = Harness::new();
        let mut c = h.client();
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "# List" }))["id"].as_str().unwrap().to_string();
        h.ok(&mut c, "drafts.append", json!({ "id": id, "text": "- milk\n", "ensureNewline": true }));
        h.ok(&mut c, "drafts.append", json!({ "id": id, "text": "- eggs", "ensureNewline": true }));
        h.ok(&mut c, "drafts.append", json!({ "id": id, "text": "!" }));
        assert_eq!(h.ok(&mut c, "drafts.get", json!({ "id": id }))["text"], "# List\n- milk\n- eggs!");
    }

    #[test]
    fn discard_only_takes_empty_drafts() {
        let mut h = Harness::new();
        let mut c = h.client();
        let full = h.ok(&mut c, "drafts.create", json!({ "text": "keep me" }))["id"].as_str().unwrap().to_string();
        let empty = h.ok(&mut c, "drafts.create", json!({ "text": "  \n" }))["id"].as_str().unwrap().to_string();
        assert_eq!(h.call(&mut c, "drafts.discard", json!({ "id": full })).0.unwrap_err().code, codes::NOT_EMPTY);
        h.ok(&mut c, "drafts.discard", json!({ "id": empty }));
        assert_eq!(titles(&h.ok(&mut c, "drafts.list", json!({}))), ["keep me"]);
    }

    #[test]
    fn export_writes_every_draft_including_unsaved_typing() {
        let mut h = Harness::new();
        let mut c = h.client();
        h.ok(&mut c, "drafts.create", json!({ "text": "# Plan\n\nfirst" }));
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "Old idea" }))["id"].clone();
        h.ok(&mut c, "drafts.setState", json!({ "id": id, "state": "trashed" }));
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("export");
        let r = h.ok(&mut c, "drafts.export", json!({ "path": out.to_str().unwrap() }));
        assert_eq!(r["drafts"], 2);
        assert_eq!(std::fs::read_to_string(out.join("Inbox/Plan.md")).unwrap(), "# Plan\n\nfirst");
        assert!(out.join("Trash/Old idea.md").exists());
        assert!(out.join("drafts.json").exists());
        let err = h.call(&mut c, "drafts.export", json!({ "path": "relative/dir" })).0.unwrap_err();
        assert_eq!(err.code, codes::INVALID_PARAMS);
    }

    #[test]
    fn empty_trash_deletes_only_trashed_drafts() {
        let mut h = Harness::new();
        let mut c = h.client();
        h.ok(&mut c, "drafts.create", json!({ "text": "keep me" }));
        for text in ["old", "older"] {
            let id = h.ok(&mut c, "drafts.create", json!({ "text": text }))["id"].clone();
            h.ok(&mut c, "drafts.setState", json!({ "id": id, "state": "trashed" }));
        }
        assert_eq!(h.ok(&mut c, "drafts.emptyTrash", json!({}))["deleted"], 2);
        assert!(titles(&h.ok(&mut c, "drafts.list", json!({ "states": ["trashed"] }))).is_empty());
        assert_eq!(titles(&h.ok(&mut c, "drafts.list", json!({}))), ["keep me"]);
        assert_eq!(h.ok(&mut c, "drafts.emptyTrash", json!({}))["deleted"], 0);
    }

    #[test]
    fn open_windows_hear_about_deletion() {
        let mut h = Harness::new();
        let mut c = h.client();
        let mut w = h.client();
        let id = h.ok(&mut c, "drafts.create", json!({ "text": "" }))["id"].as_str().unwrap().to_string();
        open_window(&mut h, &mut w, &id);
        h.ok(&mut c, "drafts.discard", json!({ "id": id }));
        assert_eq!(drain(&mut w)[0]["method"], "doc.removed");
    }

    #[test]
    fn ids_resolve_by_prefix_and_report_ambiguity() {
        let mut h = Harness::new();
        let mut c = h.client();
        h.ok(&mut c, "drafts.create", json!({ "text": "a" }));
        h.ok(&mut c, "drafts.create", json!({ "text": "b" }));
        let (r, _) = h.call(&mut c, "drafts.get", json!({ "id": "0" }));
        let err = r.unwrap_err();
        assert_eq!(err.code, codes::AMBIGUOUS_ID);
        assert_eq!(err.data.unwrap()["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(h.call(&mut c, "drafts.get", json!({ "id": "ZZZZ" })).0.unwrap_err().code, codes::NOT_FOUND);
    }

    #[test]
    fn ui_commands_go_to_the_newest_app() {
        let mut h = Harness::new();
        let mut cli = h.client();
        assert_eq!(h.call(&mut cli, "ui.capture", json!({})).0.unwrap_err().code, codes::NO_APP);
        let mut app = h.client();
        h.ok(&mut app, "hello", json!({ "protocol": 1, "client": { "kind": "app" }, "capabilities": ["ui"] }));
        h.ok(&mut cli, "ui.capture", json!({ "mode": "new" }));
        let notes = drain(&mut app);
        assert_eq!(notes[0]["method"], "ui.capture");
        assert_eq!(notes[0]["params"]["mode"], "new");
        h.daemon.disconnect(app.id);
        assert_eq!(h.call(&mut cli, "ui.capture", json!({})).0.unwrap_err().code, codes::NO_APP);
    }

    #[test]
    fn protocol_errors() {
        let mut h = Harness::new();
        let mut c = h.client();
        assert_eq!(h.call(&mut c, "nope", json!({})).0.unwrap_err().code, codes::METHOD_NOT_FOUND);
        assert_eq!(
            h.call(&mut c, "drafts.setState", json!({ "id": "x", "state": "bogus" })).0.unwrap_err().code,
            codes::INVALID_PARAMS
        );
        h.daemon.handle_line(c.id, "not json");
        assert!(drain(&mut c)[0]["error"]["code"] == codes::PARSE_ERROR);
    }

    #[test]
    fn render_produces_html() {
        let mut h = Harness::new();
        let mut c = h.client();
        let r = h.ok(&mut c, "drafts.render", json!({ "text": "**bold**" }));
        assert!(r["html"].as_str().unwrap().contains("<strong>bold</strong>"));
    }

    /// A 1×1 PNG.
    const PIXEL: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGBgAAAABQABeqhXUAAAAABJRU5ErkJggg==";

    fn attach(h: &mut Harness, c: &mut TestClient, data: &str) -> String {
        h.ok(c, "attachments.add", json!({ "data": data }))["name"].as_str().unwrap().to_string()
    }

    #[test]
    fn attachments_are_stored_once_and_read_back() {
        let mut h = Harness::new();
        let mut c = h.client();
        let name = attach(&mut h, &mut c, PIXEL);
        assert!(name.ends_with(".png"));
        assert_eq!(attach(&mut h, &mut c, PIXEL), name);
        let got = h.ok(&mut c, "attachments.get", json!({ "name": name }));
        assert_eq!((got["type"].as_str(), got["data"].as_str()), (Some("image/png"), Some(PIXEL)));

        let bad = |h: &mut Harness, c: &mut TestClient, method: &str, params: Value| {
            h.call(c, method, params).0.unwrap_err().code
        };
        assert_eq!(bad(&mut h, &mut c, "attachments.add", json!({ "data": "not base64!" })), codes::INVALID_PARAMS);
        let svg = B64.encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
        assert_eq!(bad(&mut h, &mut c, "attachments.add", json!({ "data": svg })), codes::INVALID_PARAMS);
        let missing = json!({ "name": "0123456789abcdef0123456789abcdef.png" });
        assert_eq!(bad(&mut h, &mut c, "attachments.get", missing), codes::NOT_FOUND);
        assert_eq!(bad(&mut h, &mut c, "attachments.get", json!({ "name": "../scratchpad.db" })), codes::NOT_FOUND);

        let html = h.ok(&mut c, "drafts.render", json!({ "text": format!("![](attachment:{name})") }));
        assert!(html["html"].as_str().unwrap().contains(&format!("data:image/png;base64,{PIXEL}")));
    }

    #[test]
    fn unused_attachments_are_deleted_after_a_while() {
        let mut h = Harness::new();
        let mut c = h.client();
        let kept = attach(&mut h, &mut c, PIXEL);
        let dropped = attach(&mut h, &mut c, &B64.encode(b"GIF89a, not much of one"));
        let id = h.ok(
            &mut c,
            "drafts.create",
            json!({ "text": format!("![](attachment:{kept})\n![](attachment:{dropped})") }),
        )["id"]
            .clone();
        let trashed = h.ok(&mut c, "drafts.create", json!({ "text": format!("![](attachment:{kept})") }))["id"].clone();
        h.ok(&mut c, "drafts.setState", json!({ "id": trashed, "state": "trashed" }));
        let stored = |h: &Harness| h.daemon.attachments.list().unwrap();

        h.daemon.purge();
        assert_eq!(stored(&h).len(), 2);
        // Deleting the image line starts the clock...
        h.ok(&mut c, "drafts.setText", json!({ "id": id, "text": "no images" }));
        h.daemon.purge();
        h.advance(ATTACHMENT_RETENTION_MS - 1);
        h.daemon.purge();
        assert_eq!(stored(&h).len(), 2, "not yet");
        // ...and putting it back, as an undo would, stops it.
        h.ok(&mut c, "drafts.setText", json!({ "id": id, "text": format!("![](attachment:{dropped})") }));
        h.advance(1);
        h.daemon.purge();
        h.ok(&mut c, "drafts.setText", json!({ "id": id, "text": "gone again" }));
        h.daemon.purge();
        h.advance(ATTACHMENT_RETENTION_MS / 2);
        h.daemon.purge();
        assert_eq!(stored(&h).len(), 2, "the clock started over");
        h.advance(ATTACHMENT_RETENTION_MS / 2);
        h.daemon.purge();
        // The trashed draft was purged on the way, and its image goes a
        // retention period after that.
        assert_eq!(stored(&h), std::slice::from_ref(&kept));
        h.advance(ATTACHMENT_RETENTION_MS);
        h.daemon.purge();
        assert!(stored(&h).is_empty());
        assert!(h.daemon.store.attachment_orphans().unwrap().is_empty());
    }

    #[test]
    fn one_draft_exports_with_its_images() {
        let mut h = Harness::new();
        let mut c = h.client();
        let name = attach(&mut h, &mut c, PIXEL);
        let id = h.ok(&mut c, "drafts.create", json!({ "text": format!("# Shots\n\n![](attachment:{name})") }))["id"]
            .clone();
        h.ok(&mut c, "drafts.create", json!({ "text": "Another draft" }));
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("one");
        let r = h.ok(&mut c, "drafts.export", json!({ "path": out.to_str().unwrap(), "id": id }));
        assert_eq!(r["drafts"], 1);
        assert_eq!(
            std::fs::read_to_string(out.join("Shots.md")).unwrap(),
            format!("# Shots\n\n![](attachments/{name})")
        );
        assert_eq!(B64.encode(std::fs::read(out.join("attachments").join(&name)).unwrap()), PIXEL);
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), 2, "just the draft and its images");
    }
}
