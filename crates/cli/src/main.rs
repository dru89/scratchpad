//! `scratchpad`: drafts from the command line, and an MCP server for agents.

mod client;
mod format;
mod mcp;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use client::Client;
use scratchpad_core::paths::Paths;
use scratchpad_core::protocol::{DraftDetail, DraftState, DraftSummary, ListResult, RpcError, codes, draft_link};
use serde_json::{Value, json};
use std::io::{IsTerminal, Read};

#[derive(Parser)]
#[command(
    name = "scratchpad",
    version,
    about = "Drafts from the command line. `scratchpad mcp` serves them to agents."
)]
struct Cli {
    /// Print JSON instead of text.
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List drafts, most recently modified first (the Inbox by default).
    #[command(alias = "ls")]
    List {
        #[arg(long)]
        archived: bool,
        #[arg(long)]
        trash: bool,
        /// Inbox, Archive, and Trash together.
        #[arg(long)]
        all: bool,
        #[arg(long, short = 'n', default_value_t = 50)]
        limit: usize,
    },
    /// Search the Inbox and Archive ("quoted phrases" match exactly).
    Search {
        #[arg(required = true)]
        query: Vec<String>,
        /// Search the Trash too.
        #[arg(long)]
        trash: bool,
        #[arg(long, short = 'n', default_value_t = 20)]
        limit: usize,
    },
    /// Print a draft's markdown. IDs can be shortened to any unique prefix.
    #[command(alias = "cat")]
    Show { id: String },
    /// Create a draft from the arguments, or stdin if there are none. Prints its id.
    New { text: Vec<String> },
    /// Add text (arguments or stdin) to the end of a draft.
    Append { id: String, text: Vec<String> },
    /// Replace a draft's text with stdin.
    Set { id: String },
    /// Edit a draft in $VISUAL or $EDITOR. Typing done elsewhere meanwhile is kept.
    Edit { id: String },
    /// Move a draft to the Archive.
    Archive { id: String },
    /// Move a draft to the Trash (emptied after 30 days).
    Trash { id: String },
    /// Move a draft back to the Inbox.
    Restore { id: String },
    /// Print a draft as HTML.
    Render { id: String },
    /// Summon the app's capture window. Bind this to a global shortcut.
    Capture {
        /// Always start a new draft, ignoring the idle rule.
        #[arg(long)]
        new: bool,
        /// Load this draft into the capture window.
        #[arg(long)]
        draft: Option<String>,
    },
    /// Open a draft in its own app window.
    Open { id: String },
    /// Print a draft's link, which opens it in the app.
    Link { id: String },
    /// Serve drafts to agents over MCP on stdio.
    Mcp,
    /// Start, stop, or check the background daemon.
    Daemon {
        #[command(subcommand)]
        action: DaemonCmd,
    },
}

#[derive(Subcommand)]
enum DaemonCmd {
    Status,
    Start,
    Stop,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli).await {
        eprintln!("scratchpad: {}", describe(&e));
        std::process::exit(1);
    }
}

/// Error text, with the candidates spelled out for an ambiguous id.
fn describe(e: &anyhow::Error) -> String {
    match e.downcast_ref::<RpcError>() {
        Some(rpc) if rpc.code == codes::AMBIGUOUS_ID => {
            let candidates = rpc.data.as_ref().and_then(|d| d["candidates"].as_array()).cloned().unwrap_or_default();
            let list = candidates.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
            format!("{}: {list}", rpc.message)
        }
        Some(rpc) => rpc.message.clone(),
        None => format!("{e:#}"),
    }
}

/// Text from the arguments, or stdin when there are none.
fn text_arg(words: Vec<String>) -> Result<String> {
    if !words.is_empty() {
        return Ok(words.join(" "));
    }
    if std::io::stdin().is_terminal() {
        bail!("pass the text as arguments or pipe it in");
    }
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    Ok(text)
}

/// Prints JSON, with each draft's link added as `url`.
fn print_json(v: &impl serde::Serialize) {
    let mut v = serde_json::to_value(v).unwrap();
    match &mut v {
        Value::Array(items) => items.iter_mut().for_each(add_link),
        v => add_link(v),
    }
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}

fn add_link(v: &mut Value) {
    if let Some(url) = v.get("id").and_then(Value::as_str).map(draft_link) {
        v["url"] = json!(url);
    }
}

fn print_summary(json: bool, v: &Value) -> Result<()> {
    if json {
        print_json(v);
    } else {
        let s: DraftSummary = serde_json::from_value(v.clone())?;
        println!("{}  {}", format::short_id(&s.id), s.title);
    }
    Ok(())
}

async fn run(cli: Cli) -> Result<()> {
    let paths = Paths::resolve()?;
    let json = cli.json;

    match cli.command {
        Cmd::Mcp => return mcp::serve(paths).await,
        Cmd::Daemon { action } => return daemon(&paths, action, json).await,
        _ => {}
    }

    let mut c = Client::connect(&paths, "cli").await?;
    match cli.command {
        Cmd::List { archived, trash, all, limit } => {
            let states = match (all, archived, trash) {
                (true, _, _) => vec![DraftState::Inbox, DraftState::Archived, DraftState::Trashed],
                (_, true, true) => vec![DraftState::Archived, DraftState::Trashed],
                (_, true, false) => vec![DraftState::Archived],
                (_, false, true) => vec![DraftState::Trashed],
                _ => vec![DraftState::Inbox],
            };
            let show_state = states.len() > 1;
            let r: ListResult = c.call("drafts.list", json!({ "states": states, "limit": limit })).await?;
            if json {
                print_json(&r.drafts);
            } else {
                print!("{}", format::draft_lines(&r.drafts, show_state));
            }
        }
        Cmd::Search { query, trash, limit } => {
            let mut states = vec![DraftState::Inbox, DraftState::Archived];
            if trash {
                states.push(DraftState::Trashed);
            }
            let r: ListResult =
                c.call("drafts.list", json!({ "states": states, "query": query.join(" "), "limit": limit })).await?;
            if json {
                print_json(&r.drafts);
            } else {
                print!("{}", format::draft_lines(&r.drafts, true));
            }
        }
        Cmd::Show { id } => {
            let d: Value = c.call("drafts.get", json!({ "id": id })).await?;
            if json {
                print_json(&d);
            } else {
                let text = d["text"].as_str().unwrap_or("");
                print!("{text}");
                if !text.ends_with('\n') {
                    println!();
                }
            }
        }
        Cmd::New { text } => {
            let v: Value = c.call("drafts.create", json!({ "text": text_arg(text)? })).await?;
            if json {
                print_json(&v);
            } else {
                println!("{}", v["id"].as_str().unwrap_or(""));
            }
        }
        Cmd::Append { id, text } => {
            let params = json!({ "id": id, "text": text_arg(text)?, "ensureNewline": true });
            let v: Value = c.call("drafts.append", params).await?;
            print_summary(json, &v)?;
        }
        Cmd::Set { id } => {
            let v: Value = c.call("drafts.setText", json!({ "id": id, "text": text_arg(Vec::new())? })).await?;
            print_summary(json, &v)?;
        }
        Cmd::Edit { id } => edit(&mut c, &id, json).await?,
        Cmd::Archive { id } => set_state(&mut c, &id, DraftState::Archived, json).await?,
        Cmd::Trash { id } => set_state(&mut c, &id, DraftState::Trashed, json).await?,
        Cmd::Restore { id } => set_state(&mut c, &id, DraftState::Inbox, json).await?,
        Cmd::Render { id } => {
            let v: Value = c.call("drafts.render", json!({ "id": id })).await?;
            print!("{}", v["html"].as_str().unwrap_or(""));
        }
        Cmd::Capture { new, draft } => {
            let params = json!({
                "mode": if new { "new" } else { "summon" },
                "draftId": draft,
                "activationToken": std::env::var("XDG_ACTIVATION_TOKEN").ok(),
            });
            if let Err(e) = c.call::<Value>("ui.capture", params).await {
                if !is_no_app(&e) {
                    return Err(e);
                }
                let mut args = vec!["--capture".to_string()];
                if new {
                    args.push("--new".into());
                }
                if let Some(id) = draft {
                    args.push(format!("--draft={id}"));
                }
                launch_app(&args)?;
            }
        }
        Cmd::Open { id } => {
            if let Err(e) = c.call::<Value>("ui.open", json!({ "id": id })).await {
                if !is_no_app(&e) {
                    return Err(e);
                }
                let d: DraftDetail = c.call("drafts.get", json!({ "id": id })).await?;
                launch_app(&[format!("--open={}", d.summary.id)])?;
            }
        }
        Cmd::Link { id } => {
            let d: DraftDetail = c.call("drafts.get", json!({ "id": id })).await?;
            println!("{}", draft_link(&d.summary.id));
        }
        Cmd::Mcp | Cmd::Daemon { .. } => unreachable!(),
    }
    Ok(())
}

fn is_no_app(e: &anyhow::Error) -> bool {
    e.downcast_ref::<RpcError>().is_some_and(|rpc| rpc.code == codes::NO_APP)
}

/// Starts the app when it isn't running, so the capture hotkey always works:
/// $SCRATCHPAD_APP, else the installed app on macOS, else `scratchpad-app` on
/// the PATH or in ~/.local/bin.
fn launch_app(args: &[String]) -> Result<()> {
    use std::os::unix::process::CommandExt;
    // On macOS, the installed app, found by its bundle id.
    if cfg!(target_os = "macos") && std::env::var_os("SCRATCHPAD_APP").is_none() {
        let opened = std::process::Command::new("open")
            .args(["-b", "dev.unremarkable.scratchpad", "--args"])
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|s| s.success()) {
            return Ok(());
        }
    }
    let app = std::env::var_os("SCRATCHPAD_APP").map(std::path::PathBuf::from).or_else(|| {
        let on_path = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .map(|dir| dir.join("scratchpad-app"));
        let local = std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".local/bin/scratchpad-app"));
        on_path.chain(local).find(|p| p.is_file())
    });
    let Some(app) = app else {
        bail!("the scratchpad app isn't running, and scratchpad-app isn't installed");
    };
    std::process::Command::new(&app)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .with_context(|| format!("starting {}", app.display()))?;
    Ok(())
}

async fn set_state(c: &mut Client, id: &str, state: DraftState, json: bool) -> Result<()> {
    let v: Value = c.call("drafts.setState", json!({ "id": id, "state": state })).await?;
    print_summary(json, &v)
}

/// Opens the draft in an editor, then writes it back against the version
/// that was read, so typing done in the app meanwhile isn't lost.
async fn edit(c: &mut Client, id: &str, json: bool) -> Result<()> {
    let d: DraftDetail = c.call("drafts.get", json!({ "id": id })).await?;
    let path = std::env::temp_dir().join(format!("scratchpad-{}.md", d.summary.id));
    std::fs::write(&path, &d.text)?;
    let editor = std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "vi".into());
    // Through sh so editors with arguments ("code --wait") work.
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status()
        .with_context(|| format!("running {editor}"))?;
    let edited = std::fs::read_to_string(&path);
    let _ = std::fs::remove_file(&path);
    if !status.success() {
        bail!("{editor} exited with {status}; draft unchanged");
    }
    let edited = edited?;
    if edited == d.text {
        eprintln!("No changes.");
        return Ok(());
    }
    let v: Value =
        c.call("drafts.setText", json!({ "id": d.summary.id, "text": edited, "baseVersion": d.version })).await?;
    if v["merged"] == true && !json {
        eprintln!("Merged with changes made while you were editing.");
    }
    print_summary(json, &v)
}

async fn daemon(paths: &Paths, action: DaemonCmd, json: bool) -> Result<()> {
    match action {
        DaemonCmd::Start => {
            let mut c = Client::connect(paths, "cli").await?;
            print_status(&mut c, json).await
        }
        DaemonCmd::Status => match Client::connect_existing(paths, "cli").await? {
            Some(mut c) => print_status(&mut c, json).await,
            None => {
                if json {
                    print_json(&json!({ "running": false }));
                } else {
                    println!("scratchpadd isn't running");
                }
                std::process::exit(3);
            }
        },
        DaemonCmd::Stop => {
            if let Some(mut c) = Client::connect_existing(paths, "cli").await? {
                let _: Value = c.call("daemon.shutdown", json!({})).await?;
            }
            // Wait for the socket to go away so a following start gets a fresh daemon.
            for _ in 0..100 {
                if !paths.socket.exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Ok(())
        }
    }
}

async fn print_status(c: &mut Client, json: bool) -> Result<()> {
    let s: Value = c.call("daemon.status", json!({})).await?;
    if json {
        print_json(&s);
    } else {
        println!(
            "scratchpadd {} (pid {}) · {} drafts · {} connected · up {}s",
            s["version"].as_str().unwrap_or("?"),
            s["pid"],
            s["drafts"],
            s["clients"],
            s["uptimeSec"]
        );
    }
    Ok(())
}
