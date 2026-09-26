//! A draft is one Loro document: `body` (LoroText, the markdown) and `meta`
//! (LoroMap). Clients ignore meta keys they don't know and never delete them,
//! so new fields can be added without breaking older versions.

use crate::protocol::DraftState;
use loro::{CommitOptions, LoroDoc, LoroText, LoroValue, ValueOrContainer};

pub const BODY: &str = "body";
pub const META: &str = "meta";
pub const SCHEMA: i64 = 1;

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub state: DraftState,
    pub created_at: i64,
    pub modified_at: i64,
    pub trashed_at: Option<i64>,
}

pub fn new_doc(text: &str, state: DraftState, now: i64) -> LoroDoc {
    let doc = LoroDoc::new();
    let meta = doc.get_map(META);
    meta.insert("schema", SCHEMA).expect("insert schema");
    meta.insert("state", state.as_str()).expect("insert state");
    meta.insert("createdAt", now).expect("insert createdAt");
    meta.insert("modifiedAt", now).expect("insert modifiedAt");
    if state == DraftState::Trashed {
        meta.insert("trashedAt", now).expect("insert trashedAt");
    }
    doc.get_text(BODY).insert(0, text).expect("insert body");
    doc.commit_with(CommitOptions::new().origin("create"));
    doc
}

pub fn body(doc: &LoroDoc) -> LoroText {
    doc.get_text(BODY)
}

fn meta_value(doc: &LoroDoc, key: &str) -> Option<LoroValue> {
    match doc.get_map(META).get(key)? {
        ValueOrContainer::Value(v) => Some(v),
        ValueOrContainer::Container(_) => None,
    }
}

/// Timestamps written from JavaScript arrive as doubles, from Rust as i64.
fn meta_i64(doc: &LoroDoc, key: &str) -> Option<i64> {
    match meta_value(doc, key)? {
        LoroValue::I64(n) => Some(n),
        LoroValue::Double(f) => Some(f as i64),
        _ => None,
    }
}

/// Reads the fields the daemon indexes. A missing or unknown state reads as
/// the Inbox, so a draft is never lost to a bad value.
pub fn read_meta(doc: &LoroDoc) -> Meta {
    let state = match meta_value(doc, "state") {
        Some(LoroValue::String(s)) => DraftState::parse(&s).unwrap_or(DraftState::Inbox),
        _ => DraftState::Inbox,
    };
    let created_at = meta_i64(doc, "createdAt").unwrap_or(0);
    Meta {
        state,
        created_at,
        modified_at: meta_i64(doc, "modifiedAt").unwrap_or(created_at),
        trashed_at: if state == DraftState::Trashed { meta_i64(doc, "trashedAt") } else { None },
    }
}

pub fn meta_json(doc: &LoroDoc) -> serde_json::Value {
    serde_json::to_value(doc.get_map(META).get_deep_value()).unwrap_or(serde_json::Value::Null)
}

/// Changes state without touching `modifiedAt`: archiving or restoring a
/// draft isn't an edit, and shouldn't reorder it by recency.
pub fn set_state(doc: &LoroDoc, state: DraftState, now: i64) {
    let meta = doc.get_map(META);
    meta.insert("state", state.as_str()).expect("insert state");
    if state == DraftState::Trashed {
        meta.insert("trashedAt", now).expect("insert trashedAt");
    } else if meta.get("trashedAt").is_some() {
        meta.delete("trashedAt").expect("delete trashedAt");
    }
    doc.commit_with(CommitOptions::new().origin("state"));
}

pub fn stamp_modified(doc: &LoroDoc, now: i64) {
    doc.get_map(META).insert("modifiedAt", now).expect("insert modifiedAt");
}

pub fn is_blank(doc: &LoroDoc) -> bool {
    body(doc).to_string().trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_doc_round_trips_meta() {
        let doc = new_doc("# Hi", DraftState::Inbox, 1000);
        assert_eq!(
            read_meta(&doc),
            Meta { state: DraftState::Inbox, created_at: 1000, modified_at: 1000, trashed_at: None }
        );
        assert_eq!(body(&doc).to_string(), "# Hi");
    }

    #[test]
    fn trashing_sets_and_restoring_clears_trashed_at() {
        let doc = new_doc("x", DraftState::Inbox, 1000);
        set_state(&doc, DraftState::Trashed, 2000);
        let m = read_meta(&doc);
        assert_eq!((m.state, m.trashed_at, m.modified_at), (DraftState::Trashed, Some(2000), 1000));
        set_state(&doc, DraftState::Inbox, 3000);
        let m = read_meta(&doc);
        assert_eq!((m.state, m.trashed_at), (DraftState::Inbox, None));
        assert!(meta_json(&doc).get("trashedAt").is_none());
    }

    #[test]
    fn unknown_meta_keys_survive() {
        let doc = new_doc("x", DraftState::Inbox, 1000);
        doc.get_map(META).insert("futureField", "kept").unwrap();
        set_state(&doc, DraftState::Archived, 2000);
        assert_eq!(meta_json(&doc)["futureField"], "kept");
    }

    #[test]
    fn double_timestamps_from_javascript_read_as_integers() {
        let doc = new_doc("x", DraftState::Inbox, 1000);
        doc.get_map(META).insert("modifiedAt", 1_790_000_000_123.0_f64).unwrap();
        assert_eq!(read_meta(&doc).modified_at, 1_790_000_000_123);
    }
}
