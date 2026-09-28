//! SQLite storage (docs/design.md#storage).
//!
//! `docs` and `doc_updates` hold the Loro history and are the source of
//! truth. `drafts` and `drafts_fts` are an index derived from them and can be
//! rebuilt at any time. `tombstones` remembers deletions so sync can't bring a
//! deleted draft back. `attachment_orphans` notes when each attachment stopped
//! being used, so it's deleted a while later (docs/design.md#attachments).

use crate::draft;
use crate::protocol::{DraftState, DraftSummary, EMPTY_TITLE};
use crate::search;
use anyhow::{Context, Result, bail};
use loro::{ExportMode, LoroDoc};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use std::collections::HashMap;
use std::path::Path;

/// 2 added drafts.preview.
const SCHEMA_VERSION: i64 = 2;

pub struct Store {
    conn: Connection,
    /// The schema was upgraded and the index needs filling in again.
    refresh_index: bool,
}

/// What the index holds for one draft.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexRow {
    pub state: DraftState,
    pub title: String,
    pub preview: String,
    pub created_at: i64,
    pub modified_at: i64,
    pub trashed_at: Option<i64>,
}

impl IndexRow {
    pub fn from_doc(doc: &LoroDoc) -> (IndexRow, String) {
        let meta = draft::read_meta(doc);
        let body = draft::body(doc).to_string();
        let row = IndexRow {
            state: meta.state,
            title: crate::title::title(&body),
            preview: crate::title::preview(&body),
            created_at: meta.created_at,
            modified_at: meta.modified_at,
            trashed_at: meta.trashed_at,
        };
        (row, body)
    }
}

#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    pub states: Vec<DraftState>,
    pub query: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Resolve {
    Found(String),
    NotFound,
    Ambiguous(Vec<String>),
}

/// How much un-snapshotted history a draft has.
#[derive(Debug, Clone, Copy, Default)]
pub struct Pending {
    pub updates: usize,
    pub bytes: usize,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Store> {
        conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            bail!("database schema {version} is newer than this build supports ({SCHEMA_VERSION})");
        }
        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE docs (
                    id TEXT PRIMARY KEY,
                    snapshot BLOB NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE doc_updates (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                    data BLOB NOT NULL
                );
                CREATE INDEX doc_updates_by_id ON doc_updates(id, seq);
                CREATE TABLE drafts (
                    id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
                    state TEXT NOT NULL,
                    title TEXT NOT NULL,
                    preview TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    modified_at INTEGER NOT NULL,
                    trashed_at INTEGER
                );
                CREATE INDEX drafts_by_state ON drafts(state, modified_at DESC, id DESC);
                CREATE VIRTUAL TABLE drafts_fts USING fts5(title, body, tokenize = 'trigram');
                CREATE TABLE tombstones (
                    id TEXT PRIMARY KEY,
                    deleted_at INTEGER NOT NULL
                );
                PRAGMA user_version = 2;",
            )?;
        }
        // The index is derived from the documents, so a schema change is a
        // new column plus a reindex (docs/design.md#storage).
        let refresh_index = version == 1;
        if version == 1 {
            conn.execute_batch(
                "ALTER TABLE drafts ADD COLUMN preview TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 2;",
            )?;
        }
        // A table older builds never read doesn't change the schema version,
        // so going back a version still opens the database.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS attachment_orphans (
                name TEXT PRIMARY KEY,
                since INTEGER NOT NULL
            );",
        )?;
        Ok(Store { conn, refresh_index })
    }

    // ---- documents ------------------------------------------------------

    pub fn insert_doc(&mut self, id: &str, doc: &LoroDoc, now: i64) -> Result<()> {
        let snapshot = doc.export(ExportMode::Snapshot)?;
        self.conn
            .execute("INSERT INTO docs (id, snapshot, updated_at) VALUES (?1, ?2, ?3)", params![id, snapshot, now])?;
        Ok(())
    }

    /// Loads a draft's document: its snapshot plus any updates since.
    pub fn load_doc(&self, id: &str) -> Result<Option<(LoroDoc, Pending)>> {
        let Some(snapshot): Option<Vec<u8>> =
            self.conn.query_row("SELECT snapshot FROM docs WHERE id = ?1", [id], |r| r.get(0)).optional()?
        else {
            return Ok(None);
        };
        let doc = LoroDoc::new();
        doc.import(&snapshot)?;
        let mut stmt = self.conn.prepare_cached("SELECT data FROM doc_updates WHERE id = ?1 ORDER BY seq")?;
        let mut pending = Pending::default();
        for data in stmt.query_map([id], |r| r.get::<_, Vec<u8>>(0))? {
            let data = data?;
            doc.import(&data)?;
            pending.updates += 1;
            pending.bytes += data.len();
        }
        Ok(Some((doc, pending)))
    }

    pub fn append_update(&mut self, id: &str, update: &[u8]) -> Result<()> {
        self.conn.prepare_cached("INSERT INTO doc_updates (id, data) VALUES (?1, ?2)")?.execute(params![id, update])?;
        Ok(())
    }

    /// Folds the update log into a fresh snapshot.
    pub fn compact(&mut self, id: &str, doc: &LoroDoc, now: i64) -> Result<()> {
        let snapshot = doc.export(ExportMode::Snapshot)?;
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE docs SET snapshot = ?2, updated_at = ?3 WHERE id = ?1", params![id, snapshot, now])?;
        tx.execute("DELETE FROM doc_updates WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Removes a draft entirely and records a tombstone.
    pub fn delete(&mut self, id: &str, now: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM drafts_fts WHERE rowid = (SELECT rowid FROM drafts WHERE id = ?1)", [id])?;
        tx.execute("DELETE FROM drafts WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM doc_updates WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM docs WHERE id = ?1", [id])?;
        tx.execute("INSERT OR REPLACE INTO tombstones (id, deleted_at) VALUES (?1, ?2)", params![id, now])?;
        tx.commit()?;
        Ok(())
    }

    pub fn is_tombstoned(&self, id: &str) -> Result<bool> {
        Ok(self.conn.query_row("SELECT 1 FROM tombstones WHERE id = ?1", [id], |_| Ok(())).optional()?.is_some())
    }

    // ---- index ----------------------------------------------------------

    /// Writes a draft's index row. Pass `body: None` when the text hasn't
    /// changed since it was last indexed: rewriting the search index for a
    /// large draft costs tens of milliseconds.
    pub fn upsert_index(&mut self, id: &str, row: &IndexRow, body: Option<&str>) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO drafts (id, state, title, preview, created_at, modified_at, trashed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET state = ?2, title = ?3, preview = ?4, created_at = ?5, modified_at = ?6, trashed_at = ?7",
            params![id, row.state.as_str(), row.title, row.preview, row.created_at, row.modified_at, row.trashed_at],
        )?;
        if let Some(body) = body {
            let rowid: i64 = tx.query_row("SELECT rowid FROM drafts WHERE id = ?1", [id], |r| r.get(0))?;
            tx.execute("DELETE FROM drafts_fts WHERE rowid = ?1", [rowid])?;
            tx.execute(
                "INSERT INTO drafts_fts (rowid, title, body) VALUES (?1, ?2, ?3)",
                params![rowid, row.title, body],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn summary(&self, id: &str) -> Result<Option<DraftSummary>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, state, title, created_at, modified_at, trashed_at, preview FROM drafts WHERE id = ?1",
                [id],
                summary_from_row,
            )
            .optional()?)
    }

    /// Lists drafts newest-modified first, optionally filtered by a search
    /// query. Pages with an opaque cursor.
    pub fn list(&self, q: &ListQuery) -> Result<(Vec<DraftSummary>, Option<String>)> {
        let states = if q.states.is_empty() { vec![DraftState::Inbox] } else { q.states.clone() };
        let limit = q.limit.clamp(1, 1000);
        let state_list = states.iter().map(|s| format!("'{}'", s.as_str())).collect::<Vec<_>>().join(",");

        let terms = q.query.as_deref().map(search::terms).unwrap_or_default();
        let (long, short): (Vec<String>, Vec<String>) = terms.iter().cloned().partition(|t| search::is_indexable(t));

        let mut sql =
            String::from("SELECT d.id, d.state, d.title, d.created_at, d.modified_at, d.trashed_at, d.preview");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let searching = !terms.is_empty();
        if searching && !long.is_empty() {
            sql.push_str(", f.body FROM drafts d JOIN drafts_fts f ON f.rowid = d.rowid WHERE drafts_fts MATCH ?");
            args.push(search::fts_expression(&long).into());
            for t in &short {
                sql.push_str(" AND (d.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\')");
                args.push(search::like_contains(t).into());
                args.push(search::like_contains(t).into());
            }
        } else if searching {
            // Nothing long enough for the trigram index: match title prefixes.
            sql.push_str(", NULL FROM drafts d WHERE d.title LIKE ? ESCAPE '\\'");
            args.push(search::like_prefix(q.query.as_deref().unwrap_or("").trim()).into());
        } else {
            sql.push_str(", NULL FROM drafts d WHERE 1");
        }
        sql.push_str(&format!(" AND d.state IN ({state_list})"));
        if let Some(cursor) = &q.cursor {
            let (m, id) = cursor.split_once(':').context("bad cursor")?;
            let m: i64 = m.parse().context("bad cursor")?;
            sql.push_str(" AND (d.modified_at < ? OR (d.modified_at = ? AND d.id < ?))");
            args.extend([m.into(), m.into(), id.to_string().into()]);
        }
        sql.push_str(" ORDER BY d.modified_at DESC, d.id DESC LIMIT ?");
        args.push(((limit + 1) as i64).into());

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| {
            let summary = summary_from_row(r)?;
            let body: Option<String> = r.get(7)?;
            Ok((summary, body))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (mut summary, body) = row?;
            if let Some(body) = body {
                summary.snippet = search::snippet(&body, &terms);
            }
            out.push(summary);
        }
        let next = if out.len() > limit {
            out.truncate(limit);
            out.last().map(|s| format!("{}:{}", s.modified_at, s.id))
        } else {
            None
        };
        Ok((out, next))
    }

    /// Resolves a full id or a unique, case-insensitive prefix of one.
    pub fn resolve(&self, prefix: &str) -> Result<Resolve> {
        let prefix = prefix.trim().to_ascii_uppercase();
        if prefix.is_empty() {
            return Ok(Resolve::NotFound);
        }
        let mut stmt =
            self.conn.prepare_cached("SELECT id FROM drafts WHERE id >= ?1 AND id < ?2 ORDER BY id LIMIT 6")?;
        let upper = format!("{prefix}\u{7f}");
        let ids: Vec<String> = stmt.query_map(params![prefix, upper], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(match ids.len() {
            0 => Resolve::NotFound,
            1 => Resolve::Found(ids.into_iter().next().unwrap()),
            _ if ids.contains(&prefix) => Resolve::Found(prefix),
            _ => Resolve::Ambiguous(ids),
        })
    }

    /// Trashed drafts whose trash time is before `cutoff`.
    pub fn trashed_before(&self, cutoff: i64) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM drafts WHERE state = 'trashed' AND trashed_at < ?1")?;
        Ok(stmt.query_map([cutoff], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    /// Every draft's summary, for an export.
    pub fn all_summaries(&self) -> Result<Vec<DraftSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, state, title, created_at, modified_at, trashed_at, preview FROM drafts ORDER BY modified_at DESC, id DESC",
        )?;
        Ok(stmt.query_map([], summary_from_row)?.collect::<Result<_, _>>()?)
    }

    /// Every stored draft id, for rebuilding the index.
    pub fn all_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM docs")?;
        Ok(stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    /// Whether opening upgraded the schema, so every draft needs reindexing.
    pub fn index_needs_refresh(&self) -> bool {
        self.refresh_index
    }

    pub fn indexed_count(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT count(*) FROM drafts", [], |r| r.get(0))?)
    }

    /// Every draft's text as last indexed, for finding the attachments in use.
    pub fn all_bodies(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT body FROM drafts_fts")?;
        Ok(stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)
    }

    // ---- attachments ----------------------------------------------------

    /// Attachments no draft uses, and since when.
    pub fn attachment_orphans(&self) -> Result<HashMap<String, i64>> {
        let mut stmt = self.conn.prepare("SELECT name, since FROM attachment_orphans")?;
        Ok(stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?)
    }

    pub fn set_attachment_orphan(&mut self, name: &str, since: i64) -> Result<()> {
        self.conn
            .execute("INSERT OR REPLACE INTO attachment_orphans (name, since) VALUES (?1, ?2)", params![name, since])?;
        Ok(())
    }

    pub fn clear_attachment_orphan(&mut self, name: &str) -> Result<()> {
        self.conn.execute("DELETE FROM attachment_orphans WHERE name = ?1", [name])?;
        Ok(())
    }
}

fn summary_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DraftSummary> {
    let state: String = r.get(1)?;
    let title: String = r.get(2)?;
    Ok(DraftSummary {
        id: r.get(0)?,
        title: if title.is_empty() { EMPTY_TITLE.to_string() } else { title },
        state: DraftState::parse(&state).unwrap_or(DraftState::Inbox),
        created_at: r.get(3)?,
        modified_at: r.get(4)?,
        trashed_at: r.get(5)?,
        preview: r.get(6)?,
        snippet: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draft;

    fn add(store: &mut Store, id: &str, text: &str, state: DraftState, at: i64) {
        let doc = draft::new_doc(text, state, at);
        store.insert_doc(id, &doc, at).unwrap();
        let (row, body) = IndexRow::from_doc(&doc);
        store.upsert_index(id, &row, Some(&body)).unwrap();
    }

    fn ids(list: &[DraftSummary]) -> Vec<&str> {
        list.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn lists_carry_previews() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "A", "# Groceries\n\n- milk\n- eggs", DraftState::Inbox, 100);
        add(&mut s, "B", "Only a title", DraftState::Inbox, 200);
        let (hits, _) = s.list(&ListQuery { limit: 10, ..Default::default() }).unwrap();
        assert_eq!(hits[1].preview, "milk · eggs");
        assert_eq!(hits[0].preview, "");
        assert_eq!(s.summary("A").unwrap().unwrap().preview, "milk · eggs");
    }

    #[test]
    fn a_version_1_database_gets_previews() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE drafts (id TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL,
                created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL, trashed_at INTEGER);
             PRAGMA user_version = 1;",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        assert!(s.index_needs_refresh());
        s.conn.prepare("SELECT preview FROM drafts").unwrap();
        assert!(!Store::open_in_memory().unwrap().index_needs_refresh());
    }

    #[test]
    fn documents_round_trip_with_updates() {
        let mut store = Store::open_in_memory().unwrap();
        let doc = draft::new_doc("hello", DraftState::Inbox, 1);
        store.insert_doc("A", &doc, 1).unwrap();
        let before = doc.oplog_vv();
        draft::body(&doc).insert(5, " world").unwrap();
        doc.commit();
        store.append_update("A", &doc.export(ExportMode::updates(&before)).unwrap()).unwrap();

        let (loaded, pending) = store.load_doc("A").unwrap().unwrap();
        assert_eq!(draft::body(&loaded).to_string(), "hello world");
        assert_eq!(pending.updates, 1);

        store.compact("A", &loaded, 2).unwrap();
        let (loaded, pending) = store.load_doc("A").unwrap().unwrap();
        assert_eq!(draft::body(&loaded).to_string(), "hello world");
        assert_eq!(pending.updates, 0);
        assert!(store.load_doc("missing").unwrap().is_none());
    }

    #[test]
    fn list_filters_by_state_and_sorts_by_modified() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "A", "# old", DraftState::Inbox, 100);
        add(&mut s, "B", "# new", DraftState::Inbox, 300);
        add(&mut s, "C", "# archived", DraftState::Archived, 200);
        let q = ListQuery { limit: 10, ..Default::default() };
        let (list, next) = s.list(&q).unwrap();
        assert_eq!(ids(&list), ["B", "A"]);
        assert_eq!(list[0].title, "new");
        assert!(next.is_none());

        let q = ListQuery { states: vec![DraftState::Inbox, DraftState::Archived], limit: 10, ..Default::default() };
        assert_eq!(ids(&s.list(&q).unwrap().0), ["B", "C", "A"]);
    }

    #[test]
    fn list_pages_with_a_cursor() {
        let mut s = Store::open_in_memory().unwrap();
        for i in 0..5 {
            add(&mut s, &format!("D{i}"), "x", DraftState::Inbox, 100 + i);
        }
        let mut q = ListQuery { limit: 2, ..Default::default() };
        let (page1, next) = s.list(&q).unwrap();
        assert_eq!(ids(&page1), ["D4", "D3"]);
        q.cursor = next;
        let (page2, next) = s.list(&q).unwrap();
        assert_eq!(ids(&page2), ["D2", "D1"]);
        q.cursor = next;
        let (page3, next) = s.list(&q).unwrap();
        assert_eq!(ids(&page3), ["D0"]);
        assert!(next.is_none());
    }

    #[test]
    fn search_matches_partial_words_and_phrases() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "A", "# Sync notes\n\nWe need to resync the phone.", DraftState::Inbox, 100);
        add(&mut s, "B", "# Grocery list\n\nmilk, eggs", DraftState::Inbox, 200);
        add(&mut s, "C", "# Archived sync idea", DraftState::Archived, 300);
        let search = |query: &str, states: Vec<DraftState>| {
            let q = ListQuery { states, query: Some(query.into()), limit: 10, ..Default::default() };
            s.list(&q).unwrap().0
        };
        let hits = search("sync", vec![DraftState::Inbox]);
        assert_eq!(ids(&hits), ["A"]);
        assert!(hits[0].snippet.as_deref().unwrap().to_lowercase().contains("sync"));
        assert_eq!(ids(&search("sync", vec![DraftState::Inbox, DraftState::Archived])), ["C", "A"]);
        assert_eq!(ids(&search("\"the phone\"", vec![DraftState::Inbox])), ["A"]);
        assert_eq!(ids(&search("milk eggs", vec![DraftState::Inbox])), ["B"]);
        assert!(search("milk zebra", vec![DraftState::Inbox]).is_empty());
        // Too short for trigrams: falls back to title prefix.
        assert_eq!(ids(&search("gr", vec![DraftState::Inbox])), ["B"]);
        // FTS syntax in user input is treated as text.
        assert!(search("NOT OR AND", vec![DraftState::Inbox]).is_empty());
    }

    #[test]
    fn resolve_accepts_unique_prefixes() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "01ABCDEF", "x", DraftState::Inbox, 1);
        add(&mut s, "01ABCXYZ", "x", DraftState::Inbox, 1);
        assert_eq!(s.resolve("01abcd").unwrap(), Resolve::Found("01ABCDEF".into()));
        assert!(matches!(s.resolve("01ABC").unwrap(), Resolve::Ambiguous(v) if v.len() == 2));
        assert_eq!(s.resolve("zz").unwrap(), Resolve::NotFound);
        assert_eq!(s.resolve("01ABCDEF").unwrap(), Resolve::Found("01ABCDEF".into()));
    }

    #[test]
    fn delete_removes_everything_and_leaves_a_tombstone() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "A", "# gone soon", DraftState::Trashed, 100);
        assert_eq!(s.trashed_before(200).unwrap(), ["A"]);
        s.delete("A", 300).unwrap();
        assert!(s.load_doc("A").unwrap().is_none());
        assert!(s.summary("A").unwrap().is_none());
        assert!(s.is_tombstoned("A").unwrap());
        let q = ListQuery {
            states: vec![DraftState::Trashed],
            query: Some("gone".into()),
            limit: 10,
            ..Default::default()
        };
        assert!(s.list(&q).unwrap().0.is_empty());
    }

    #[test]
    fn remembers_orphaned_attachments_and_bodies() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "A", "# One\n\n![](attachment:x)", DraftState::Inbox, 1);
        add(&mut s, "B", "Two", DraftState::Trashed, 2);
        let mut bodies = s.all_bodies().unwrap();
        bodies.sort();
        assert_eq!(bodies, ["# One\n\n![](attachment:x)", "Two"]);

        s.set_attachment_orphan("a.png", 10).unwrap();
        s.set_attachment_orphan("b.png", 20).unwrap();
        s.clear_attachment_orphan("a.png").unwrap();
        assert_eq!(s.attachment_orphans().unwrap(), HashMap::from([("b.png".to_string(), 20)]));
    }

    #[test]
    fn empty_titles_show_as_new_draft() {
        let mut s = Store::open_in_memory().unwrap();
        add(&mut s, "A", "", DraftState::Inbox, 1);
        assert_eq!(s.summary("A").unwrap().unwrap().title, EMPTY_TITLE);
    }
}
