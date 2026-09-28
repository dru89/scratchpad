//! Wire types for the daemon's JSON-RPC protocol (docs/design.md#protocol).
//! Field names are camelCase on the wire. Unknown fields are ignored so older
//! peers keep working when newer ones add parameters.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftState {
    Inbox,
    Archived,
    Trashed,
}

impl DraftState {
    pub fn as_str(self) -> &'static str {
        match self {
            DraftState::Inbox => "inbox",
            DraftState::Archived => "archived",
            DraftState::Trashed => "trashed",
        }
    }

    pub fn parse(s: &str) -> Option<DraftState> {
        match s {
            "inbox" => Some(DraftState::Inbox),
            "archived" => Some(DraftState::Archived),
            "trashed" => Some(DraftState::Trashed),
            _ => None,
        }
    }
}

/// What lists show for a draft whose body has no text yet.
pub const EMPTY_TITLE: &str = "New draft";

/// The link that opens a draft in the app, in its own window.
pub fn draft_link(id: &str) -> String {
    format!("scratchpad://open/{id}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub title: String,
    pub state: DraftState,
    pub created_at: i64,
    pub modified_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<i64>,
    /// The text after the title, stripped of markdown, for list rows.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub preview: String,
    /// Present in search results: text around the first match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDetail {
    #[serde(flatten)]
    pub summary: DraftSummary,
    pub text: String,
    /// The whole meta map, including keys this version doesn't know about.
    pub meta: Value,
    /// Opaque version of `text`. Pass it back as `baseVersion` to setText so
    /// the edit merges with anything written since.
    pub version: String,
}

// ---- params -------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hello {
    pub protocol: u32,
    pub client: ClientInfo,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientInfo {
    pub kind: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListParams {
    /// Which states to include. Defaults to the Inbox.
    pub states: Option<Vec<DraftState>>,
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub drafts: Vec<DraftSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// drafts.get. With `knownVersion`, an unchanged draft comes back as
/// `{unchanged: true, version, ...summary}` without its text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetParams {
    pub id: String,
    #[serde(default)]
    pub known_version: Option<String>,
}

/// Any method that addresses one draft. `id` may be a unique prefix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdParams {
    pub id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateParams {
    pub text: String,
    pub state: Option<DraftState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextParams {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendParams {
    pub id: String,
    pub text: String,
    /// Start on a new line if the draft doesn't already end with one.
    #[serde(default)]
    pub ensure_newline: bool,
}

/// Replaces a draft's text. With `baseVersion` (from drafts.get), the change
/// is computed against that version and merged, so edits made since survive.
/// Without it, the text replaces whatever the draft holds now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTextParams {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub base_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetStateParams {
    pub id: String,
    pub state: DraftState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderParams {
    pub id: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportParams {
    /// An absolute path: a new or empty folder, or with `zip`, a file.
    pub path: String,
    #[serde(default)]
    pub zip: bool,
    /// Replace an existing zip.
    #[serde(default)]
    pub overwrite: bool,
    /// Export only this draft: its markdown and the images it uses, without
    /// the Inbox/Archive/Trash folders or the manifest.
    #[serde(default)]
    pub id: Option<String>,
}

/// attachments.add: an image's bytes, base64-encoded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAttachmentParams {
    pub data: String,
}

/// attachments.get: an attachment's name, as in `attachment:<name>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentParams {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpenParams {
    pub id: String,
    /// Base64 Loro version vector the client already has.
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocOpenResult {
    /// Base64 snapshot, or the updates since the client's version.
    pub data: String,
    /// Base64 version vector of the daemon's copy.
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPushParams {
    pub id: String,
    /// Base64 Loro update.
    pub update: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptureParams {
    /// "summon" (apply the idle rule) or "new" (always a fresh draft).
    pub mode: Option<String>,
    pub draft_id: Option<String>,
    /// Forwarded so the app can take focus on Wayland.
    pub activation_token: Option<String>,
}

// ---- errors -------------------------------------------------------------

pub mod codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;
    pub const NOT_FOUND: i64 = -32001;
    pub const AMBIGUOUS_ID: i64 = -32002;
    pub const NOT_EMPTY: i64 = -32003;
    pub const NO_APP: i64 = -32004;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), data: None }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_PARAMS, message)
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self::new(codes::INTERNAL, err.to_string())
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for RpcError {}

pub fn request(id: u64, method: &str, params: Value) -> String {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

pub fn notification(method: &str, params: Value) -> String {
    serde_json::json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string()
}

pub fn response(id: Value, result: Result<Value, RpcError>) -> String {
    match result {
        Ok(result) => serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => serde_json::json!({"jsonrpc": "2.0", "id": id, "error": error}),
    }
    .to_string()
}
