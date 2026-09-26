//! `scratchpad mcp`: an MCP server on stdio that gives agents the draft
//! tools from docs/design.md#protocol. Nothing here deletes permanently.

use crate::client::Client;
use crate::format::iso8601;
use anyhow::Result;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData as McpError, ServerHandler, ServiceExt, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use scratchpad_core::paths::Paths;
use scratchpad_core::protocol::{DraftDetail, DraftState, DraftSummary, ListResult, RpcError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

const INSTRUCTIONS: &str = "\
Drafts are markdown notes from the user's scratchpad app, where text starts before it goes somewhere else.

You are one of several editors. The user may be typing in the app, on this device or another, and other agents may be \
editing too. Every change, yours included, is merged into the draft, so its text afterward can differ from what you sent.

To edit a draft:
1. Read it with get_draft, and keep its version together with its text.
2. Send your complete revised text to update_draft with that version as base_version. Your change is merged with anything \
written since you read the draft instead of overwriting it.
3. Check merged in the result. If it's false, the draft is now exactly your text, and the returned version goes with it, so \
you can edit again from there. If it's true, other edits were combined with yours: read the draft again before your next \
edit, because your copy is out of date.
4. If time has passed since you read a draft, call get_draft with known_version. It returns unchanged, without the text, \
when nobody has edited it.

Never pair a version with text you didn't read at that version; the merge would treat the difference as your deletions. \
append_to_draft adds to the end and needs no version. Ids can be shortened to any unique prefix. Nothing here deletes \
permanently: trash_draft moves a draft to the Trash, which empties after 30 days.";

#[derive(Clone)]
pub struct Scratchpad {
    paths: Paths,
    client: Arc<Mutex<Option<Client>>>,
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, JsonSchema)]
pub struct ListArgs {
    /// "inbox" (default), "archived", "trashed", or "all" for inbox and archived together.
    pub state: Option<String>,
    /// Maximum number of drafts to return (default 50).
    pub limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct SearchArgs {
    /// Words must all match, anywhere in the title or text; "quoted phrases" match exactly.
    pub query: String,
    /// Also search the Trash.
    pub include_trash: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
pub struct IdArgs {
    /// Draft id, or any unique prefix of it.
    pub id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct GetArgs {
    /// Draft id, or any unique prefix of it.
    pub id: String,
    /// A version you already have. If the draft hasn't changed since, the result is marked unchanged and leaves out the text.
    pub known_version: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct CreateArgs {
    /// Markdown text. The first line becomes the title.
    pub text: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct UpdateArgs {
    pub id: String,
    /// The complete new markdown text of the draft.
    pub text: String,
    /// The version that goes with the text you based this on (from get_draft, or from an earlier update_draft that reported
    /// merged: false). With it, your change merges with edits made since; without it, your text replaces whatever the draft
    /// holds now, including anything the user just typed.
    pub base_version: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct AppendArgs {
    pub id: String,
    /// Markdown to add at the end. It starts on a new line if the draft doesn't already end with one; add a leading blank
    /// line for a new paragraph.
    pub text: String,
}

fn summary_json(d: &DraftSummary) -> Value {
    let mut v = json!({
        "id": d.id,
        "title": d.title,
        "state": d.state,
        "created": iso8601(d.created_at),
        "modified": iso8601(d.modified_at),
    });
    if let Some(t) = d.trashed_at {
        v["trashed"] = json!(iso8601(t));
    }
    if let Some(s) = &d.snippet {
        v["snippet"] = json!(s);
    }
    v
}

fn json_result(v: Value) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(serde_json::to_string_pretty(&v).unwrap())])
}

impl Scratchpad {
    pub fn new(paths: Paths) -> Self {
        Scratchpad { paths, client: Arc::new(Mutex::new(None)), tool_router: Self::tool_router() }
    }

    /// Calls the daemon, reconnecting (and starting it) if needed. Daemon
    /// errors such as an unknown id become tool errors the agent can read.
    async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> Result<T, CallToolResult> {
        let mut guard = self.client.lock().await;
        if guard.is_none() {
            match Client::connect(&self.paths, "mcp").await {
                Ok(c) => *guard = Some(c),
                Err(e) => {
                    return Err(CallToolResult::error(vec![ContentBlock::text(format!(
                        "can't reach scratchpadd: {e:#}"
                    ))]));
                }
            }
        }
        match guard.as_mut().unwrap().call(method, params).await {
            Ok(v) => Ok(v),
            Err(e) => {
                let message = match e.downcast_ref::<RpcError>() {
                    Some(rpc) => match &rpc.data {
                        Some(data) => format!("{} {}", rpc.message, data),
                        None => rpc.message.clone(),
                    },
                    None => {
                        // The connection itself failed; start fresh next time.
                        *guard = None;
                        format!("lost the connection to scratchpadd ({e:#}); try again")
                    }
                };
                Err(CallToolResult::error(vec![ContentBlock::text(message)]))
            }
        }
    }

    async fn summary_call(&self, method: &str, params: Value) -> CallToolResult {
        match self.call::<Value>(method, params).await {
            Ok(v) => {
                let mut out =
                    serde_json::from_value::<DraftSummary>(v.clone()).map(|s| summary_json(&s)).unwrap_or(v.clone());
                for key in ["version", "merged"] {
                    if let Some(value) = v.get(key) {
                        out[key] = value.clone();
                    }
                }
                json_result(out)
            }
            Err(e) => e,
        }
    }

    async fn set_state(&self, id: String, state: DraftState) -> CallToolResult {
        self.summary_call("drafts.setState", json!({ "id": id, "state": state })).await
    }
}

#[tool_router]
impl Scratchpad {
    #[tool(
        description = "List drafts, most recently modified first. Returns id, title, state, and timestamps.",
        annotations(read_only_hint = true)
    )]
    async fn list_drafts(&self, Parameters(args): Parameters<ListArgs>) -> Result<CallToolResult, McpError> {
        let states = match args.state.as_deref().unwrap_or("inbox") {
            "all" => json!(["inbox", "archived"]),
            s => match DraftState::parse(s) {
                Some(state) => json!([state]),
                None => return Ok(CallToolResult::error(vec![ContentBlock::text(format!("unknown state {s}"))])),
            },
        };
        let params = json!({ "states": states, "limit": args.limit.unwrap_or(50) });
        Ok(match self.call::<ListResult>("drafts.list", params).await {
            Ok(r) => json_result(Value::Array(r.drafts.iter().map(summary_json).collect())),
            Err(e) => e,
        })
    }

    #[tool(
        description = "Search drafts by text. Matches partial words (three characters or more) in titles and bodies. \
                       Searches the Inbox and Archive unless include_trash is set. Each result has a snippet around the match.",
        annotations(read_only_hint = true)
    )]
    async fn search_drafts(&self, Parameters(args): Parameters<SearchArgs>) -> Result<CallToolResult, McpError> {
        let mut states = vec!["inbox", "archived"];
        if args.include_trash.unwrap_or(false) {
            states.push("trashed");
        }
        let params = json!({ "states": states, "query": args.query, "limit": args.limit.unwrap_or(20) });
        Ok(match self.call::<ListResult>("drafts.list", params).await {
            Ok(r) => json_result(Value::Array(r.drafts.iter().map(summary_json).collect())),
            Err(e) => e,
        })
    }

    #[tool(
        description = "Read a draft: its metadata, including the version that goes with this text, followed by its full \
                       markdown. Pass known_version to skip the text when nothing has changed.",
        annotations(read_only_hint = true)
    )]
    async fn get_draft(&self, Parameters(args): Parameters<GetArgs>) -> Result<CallToolResult, McpError> {
        let mut params = json!({ "id": args.id });
        if let Some(known) = args.known_version {
            params["knownVersion"] = json!(known);
        }
        Ok(match self.call::<Value>("drafts.get", params).await {
            Ok(v) if v["unchanged"] == true => {
                let mut meta =
                    serde_json::from_value::<DraftSummary>(v.clone()).map(|s| summary_json(&s)).unwrap_or_default();
                meta["version"] = v["version"].clone();
                meta["unchanged"] = json!(true);
                json_result(meta)
            }
            Ok(v) => match serde_json::from_value::<DraftDetail>(v) {
                Ok(d) => {
                    let mut meta = summary_json(&d.summary);
                    meta["version"] = json!(d.version);
                    CallToolResult::success(vec![
                        ContentBlock::text(serde_json::to_string_pretty(&meta).unwrap()),
                        ContentBlock::text(d.text),
                    ])
                }
                Err(e) => {
                    CallToolResult::error(vec![ContentBlock::text(format!("unexpected reply from scratchpadd: {e}"))])
                }
            },
            Err(e) => e,
        })
    }

    #[tool(description = "Create a new draft in the Inbox. Returns its id and title.")]
    async fn create_draft(&self, Parameters(args): Parameters<CreateArgs>) -> Result<CallToolResult, McpError> {
        Ok(self.summary_call("drafts.create", json!({ "text": args.text })).await)
    }

    #[tool(
        description = "Replace a draft's text with your complete revision, merged with any edits made since base_version. \
                       Returns the new version and merged: if merged is true, other edits were combined with yours and you \
                       should read the draft again before editing it further. Sending the same update twice applies it twice.",
        annotations(destructive_hint = false)
    )]
    async fn update_draft(&self, Parameters(args): Parameters<UpdateArgs>) -> Result<CallToolResult, McpError> {
        let mut params = json!({ "id": args.id, "text": args.text });
        if let Some(base) = args.base_version {
            params["baseVersion"] = json!(base);
        }
        Ok(self.summary_call("drafts.setText", params).await)
    }

    #[tool(description = "Add text to the end of a draft.", annotations(destructive_hint = false))]
    async fn append_to_draft(&self, Parameters(args): Parameters<AppendArgs>) -> Result<CallToolResult, McpError> {
        Ok(self.summary_call("drafts.append", json!({ "id": args.id, "text": args.text, "ensureNewline": true })).await)
    }

    #[tool(description = "Move a draft to the Archive.", annotations(destructive_hint = false, idempotent_hint = true))]
    async fn archive_draft(&self, Parameters(args): Parameters<IdArgs>) -> Result<CallToolResult, McpError> {
        Ok(self.set_state(args.id, DraftState::Archived).await)
    }

    #[tool(
        description = "Move a draft to the Trash. It can be restored for 30 days, then it's deleted.",
        annotations(destructive_hint = false, idempotent_hint = true)
    )]
    async fn trash_draft(&self, Parameters(args): Parameters<IdArgs>) -> Result<CallToolResult, McpError> {
        Ok(self.set_state(args.id, DraftState::Trashed).await)
    }

    #[tool(
        description = "Move a draft from the Archive or Trash back to the Inbox.",
        annotations(idempotent_hint = true)
    )]
    async fn restore_draft(&self, Parameters(args): Parameters<IdArgs>) -> Result<CallToolResult, McpError> {
        Ok(self.set_state(args.id, DraftState::Inbox).await)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Scratchpad {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("scratchpad", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

pub async fn serve(paths: Paths) -> Result<()> {
    let service = Scratchpad::new(paths).serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
