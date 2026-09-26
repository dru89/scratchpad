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

const INSTRUCTIONS: &str = "Drafts are markdown notes from the user's scratchpad app: a place where text starts before it goes somewhere else. \
Ids can be shortened to any unique prefix. Before editing, read the draft with get_draft and pass its version to update_draft as \
base_version, so your edit merges with anything the user types in the meantime instead of overwriting it. Nothing here deletes \
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
pub struct CreateArgs {
    /// Markdown text. The first line becomes the title.
    pub text: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct UpdateArgs {
    pub id: String,
    /// The complete new markdown text of the draft.
    pub text: String,
    /// The version from get_draft. With it, your change merges with edits made since you read the draft; without it, your
    /// text replaces whatever the draft holds now.
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
                if let Some(version) = v.get("version") {
                    out["version"] = version.clone();
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
        description = "Read a draft: its metadata (including the version to pass to update_draft) followed by its full markdown.",
        annotations(read_only_hint = true)
    )]
    async fn get_draft(&self, Parameters(args): Parameters<IdArgs>) -> Result<CallToolResult, McpError> {
        Ok(match self.call::<DraftDetail>("drafts.get", json!({ "id": args.id })).await {
            Ok(d) => {
                let mut meta = summary_json(&d.summary);
                meta["version"] = json!(d.version);
                CallToolResult::success(vec![
                    ContentBlock::text(serde_json::to_string_pretty(&meta).unwrap()),
                    ContentBlock::text(d.text),
                ])
            }
            Err(e) => e,
        })
    }

    #[tool(description = "Create a new draft in the Inbox. Returns its id and title.")]
    async fn create_draft(&self, Parameters(args): Parameters<CreateArgs>) -> Result<CallToolResult, McpError> {
        Ok(self.summary_call("drafts.create", json!({ "text": args.text })).await)
    }

    #[tool(
        description = "Replace a draft's text. Pass base_version from get_draft so the change merges with anything the user \
                       typed since you read it. Returns the new version.",
        annotations(destructive_hint = false, idempotent_hint = true)
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
