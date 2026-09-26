//! Drives the real `scratchpad` binary against a real daemon in a temporary
//! data directory. Run with `cargo test --workspace` so scratchpadd is built.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

struct Env {
    dir: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        let daemon = PathBuf::from(env!("CARGO_BIN_EXE_scratchpad")).with_file_name("scratchpadd");
        assert!(daemon.exists(), "build scratchpadd first: cargo test --workspace");
        Env { dir: tempfile::tempdir().unwrap() }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_scratchpad"));
        c.env("SCRATCHPAD_DATA_DIR", self.dir.path().join("data"))
            .env("SCRATCHPAD_SOCKET", self.dir.path().join("run/daemon.sock"))
            .env("SCRATCHPAD_APP", self.dir.path().join("no-app-installed"))
            .env_remove("XDG_ACTIVATION_TOKEN");
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd().args(args).stdin(Stdio::null()).output().unwrap()
    }

    /// Runs a command that must succeed and returns its stdout.
    fn ok(&self, args: &[&str]) -> String {
        let out = self.run(args);
        assert!(out.status.success(), "{args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn with_stdin(&self, args: &[&str], input: &str) -> String {
        let mut child = self.cmd().args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{args:?} failed");
        String::from_utf8(out.stdout).unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = self.run(&["daemon", "stop"]);
    }
}

#[test]
fn the_draft_lifecycle_from_the_command_line() {
    let env = Env::new();
    let id = env.ok(&["new", "#", "Groceries"]).trim().to_string();
    assert_eq!(id.len(), 26, "new prints the full id");
    let piped = env.with_stdin(&["new"], "**Idea:** a scratchpad\n\nthat syncs").trim().to_string();

    let list = env.ok(&["list"]);
    let lines: Vec<&str> = list.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].ends_with("Idea: a scratchpad"), "newest first: {list}");
    assert!(lines[1].ends_with("Groceries"));

    env.ok(&["append", &id, "\n\n- milk\n- eggs"]);
    assert_eq!(env.ok(&["show", &id[..14]]), "# Groceries\n\n- milk\n- eggs\n");

    let hits = env.ok(&["search", "eggs"]);
    assert!(hits.contains("Groceries") && hits.contains("eggs"), "{hits}");
    assert!(env.ok(&["search", "zebra"]).is_empty());

    env.with_stdin(&["set", &piped], "# Replaced\n");
    assert_eq!(env.ok(&["show", &piped]), "# Replaced\n");

    env.ok(&["archive", &id]);
    assert!(!env.ok(&["list"]).contains("Groceries"));
    assert!(env.ok(&["list", "--archived"]).contains("Groceries"));
    env.ok(&["trash", &id]);
    assert!(env.ok(&["list", "--trash"]).contains("Groceries"));
    assert!(!env.ok(&["search", "eggs"]).contains("Groceries"), "search skips the Trash by default");
    assert!(env.ok(&["search", "--trash", "eggs"]).contains("Groceries"));
    env.ok(&["restore", &id]);
    assert!(env.ok(&["list"]).contains("Groceries"));

    assert!(env.ok(&["render", &id]).contains("<li>milk</li>"));
}

#[test]
fn json_output_and_errors() {
    let env = Env::new();
    let created: Value = serde_json::from_str(&env.ok(&["--json", "new", "hello"])).unwrap();
    let id = created["id"].as_str().unwrap();
    let shown: Value = serde_json::from_str(&env.ok(&["--json", "show", id])).unwrap();
    assert_eq!(shown["text"], "hello");
    assert_eq!(shown["state"], "inbox");
    assert!(shown["version"].is_string());

    let missing = env.run(&["show", "ZZZZZZ"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("no draft matches ZZZZZZ"));

    env.ok(&["new", "another"]);
    let ambiguous = env.run(&["show", "0"]);
    assert!(String::from_utf8_lossy(&ambiguous.stderr).contains("matches more than one draft"));

    let capture = env.run(&["capture"]);
    assert!(!capture.status.success(), "no app and no launcher: capture fails");
}

#[test]
fn capture_starts_the_app_when_it_isnt_running() {
    let env = Env::new();
    let log = env.dir.path().join("launched");
    let fake = env.dir.path().join("fake-app");
    std::fs::write(&fake, format!("#!/bin/sh\necho \"$@\" >> {}\n", log.display())).unwrap();
    std::fs::set_permissions(&fake, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let id = env.ok(&["new", "draft to open"]).trim().to_string();

    for args in [&["capture"][..], &["capture", "--new"], &["open", &id[..14]]] {
        let out = env.cmd().args(args).env("SCRATCHPAD_APP", &fake).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }
    let mut launched = String::new();
    for _ in 0..50 {
        launched = std::fs::read_to_string(&log).unwrap_or_default();
        if launched.lines().count() == 3 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(launched, format!("--capture\n--capture --new\n--open={id}\n"));
}

#[test]
fn edit_writes_back_through_the_editor() {
    let env = Env::new();
    let id = env.ok(&["new", "alpha beta"]).trim().to_string();
    let out = env.cmd().args(["edit", &id]).env("VISUAL", "sed -i s/alpha/ALPHA/").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(env.ok(&["show", &id]), "ALPHA beta\n");

    let unchanged = env.cmd().args(["edit", &id]).env("VISUAL", "true").output().unwrap();
    assert!(String::from_utf8_lossy(&unchanged.stderr).contains("No changes"));
}

#[test]
fn daemon_start_status_stop() {
    let env = Env::new();
    assert_eq!(env.run(&["daemon", "status"]).status.code(), Some(3));
    assert!(env.ok(&["daemon", "start"]).contains("scratchpadd"));
    let status: Value = serde_json::from_str(&env.ok(&["--json", "daemon", "status"])).unwrap();
    assert!(status["pid"].as_u64().unwrap() > 0);
    env.ok(&["daemon", "stop"]);
    assert_eq!(env.run(&["daemon", "status"]).status.code(), Some(3));
}

/// A minimal MCP client speaking newline-delimited JSON-RPC over stdio.
struct Mcp {
    child: std::process::Child,
    out: BufReader<std::process::ChildStdout>,
    next: u64,
}

impl Mcp {
    fn start(env: &Env) -> Mcp {
        let mut child = env.cmd().arg("mcp").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        let mut mcp = Mcp { child, out, next: 0 };
        let init = mcp.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" },
            }),
        );
        assert_eq!(init["result"]["serverInfo"]["name"], "scratchpad", "{init}");
        mcp.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        mcp
    }

    fn send(&mut self, msg: Value) {
        let stdin = self.child.stdin.as_mut().unwrap();
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let mut line = String::new();
            assert!(self.out.read_line(&mut line).unwrap() > 0, "mcp server exited");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == id {
                return v;
            }
        }
    }

    fn tool(&mut self, name: &str, args: Value) -> Value {
        let r = self.request("tools/call", json!({ "name": name, "arguments": args }));
        r["result"].clone()
    }

    fn tool_json(&mut self, name: &str, args: Value) -> Value {
        let r = self.tool(name, args);
        assert_ne!(r["isError"], true, "{name} failed: {r}");
        serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn mcp_tools_work_end_to_end() {
    let env = Env::new();
    let mut mcp = Mcp::start(&env);

    let tools = mcp.request("tools/list", json!({}));
    let mut names: Vec<&str> =
        tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "append_to_draft",
            "archive_draft",
            "create_draft",
            "get_draft",
            "list_drafts",
            "restore_draft",
            "search_drafts",
            "trash_draft",
            "update_draft"
        ]
    );

    let created = mcp.tool_json("create_draft", json!({ "text": "# Agent notes\n\nfirst line" }));
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["title"], "Agent notes");

    // Read, then the user edits via the CLI, then the agent writes its
    // revision of what it read: both changes survive.
    let read = mcp.tool("get_draft", json!({ "id": id }));
    let meta: Value = serde_json::from_str(read["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(read["content"][1]["text"], "# Agent notes\n\nfirst line");
    env.ok(&["append", &id, "\nuser typed this"]);
    let updated = mcp.tool_json(
        "update_draft",
        json!({ "id": id, "text": "# Agent notes\n\nFIRST LINE", "base_version": meta["version"] }),
    );
    assert_eq!(updated["merged"], true, "the user's append was merged in");
    assert_eq!(env.ok(&["show", &id]), "# Agent notes\n\nFIRST LINE\nuser typed this\n");

    // Checking for changes is cheap when nothing has changed.
    let fresh = mcp.tool("get_draft", json!({ "id": id }));
    let fresh_meta: Value = serde_json::from_str(fresh["content"][0]["text"].as_str().unwrap()).unwrap();
    let same = mcp.tool_json("get_draft", json!({ "id": id, "known_version": fresh_meta["version"] }));
    assert_eq!(same["unchanged"], true);

    // An uncontested edit isn't merged, and its version can be chained.
    let next = mcp.tool_json(
        "update_draft",
        json!({ "id": id, "text": "# Agent notes\n\nFIRST LINE\nuser typed this\n\nagent line", "base_version": fresh_meta["version"] }),
    );
    assert_eq!(next["merged"], false);

    let hits = mcp.tool_json("search_drafts", json!({ "query": "user typed" }));
    assert_eq!(hits[0]["id"], id.as_str());
    assert!(hits[0]["snippet"].as_str().unwrap().contains("user typed"));

    mcp.tool_json("append_to_draft", json!({ "id": id, "text": "\n\nappended by agent" }));
    mcp.tool_json("trash_draft", json!({ "id": id }));
    assert!(mcp.tool_json("list_drafts", json!({})).as_array().unwrap().is_empty());
    assert_eq!(mcp.tool_json("list_drafts", json!({ "state": "trashed" }))[0]["id"], id.as_str());
    mcp.tool_json("restore_draft", json!({ "id": id }));

    let missing = mcp.tool("get_draft", json!({ "id": "ZZZZ" }));
    assert_eq!(missing["isError"], true);
    assert!(missing["content"][0]["text"].as_str().unwrap().contains("no draft matches"));
}
