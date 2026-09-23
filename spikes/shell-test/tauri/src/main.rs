// Tauri shell for the shell test. Mirrors electron/main.cjs command for
// command so the two differ only in engine and IPC.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

fn root() -> PathBuf {
    PathBuf::from(ROOT)
}

fn wall_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
}

struct Pending {
    t0: f64,
    mode: String,
    auto_hide: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Timing {
    label: String,
    mode: String,
    ms: f64,
    rtt_ms: f64,
}

#[derive(Default)]
struct Spike {
    pending: Mutex<HashMap<String, Pending>>,
    timings: Mutex<Vec<Timing>>,
    cold_count: Mutex<u32>,
}

fn title_for(label: &str) -> String {
    match label {
        "main" => "scratchpad spike — main".into(),
        "capture-warm" => "scratchpad spike — capture".into(),
        other => format!("scratchpad spike — {other}"),
    }
}

fn build_capture<M: Manager<tauri::Wry>>(m: &M, label: &str, visible: bool) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(m, label, WebviewUrl::App("index.html".into()))
        .title(title_for(label))
        .inner_size(560.0, 380.0)
        .always_on_top(true)
        .visible(visible)
        .build()
}

fn open_capture_impl(app: &AppHandle, mode: &str, auto_hide: bool) -> Result<(), String> {
    let st = app.state::<Spike>();
    match mode {
        "warm" => {
            let w = app.get_webview_window("capture-warm").ok_or("no warm capture window")?;
            st.pending.lock().unwrap().insert(
                "capture-warm".into(),
                Pending { t0: wall_now(), mode: "warm".into(), auto_hide },
            );
            w.show().map_err(|e| e.to_string())?;
            let _ = w.set_focus();
            app.emit("capture-shown", "capture-warm").map_err(|e| e.to_string())?;
        }
        "cold" => {
            let n = {
                let mut c = st.cold_count.lock().unwrap();
                *c += 1;
                *c
            };
            let label = format!("capture-cold-{n}");
            st.pending.lock().unwrap().insert(
                label.clone(),
                Pending { t0: wall_now(), mode: "cold".into(), auto_hide },
            );
            build_capture(app, &label, true).map_err(|e| e.to_string())?;
        }
        other => return Err(format!("unknown capture mode {other}")),
    }
    Ok(())
}

fn run_script(file: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(root().join("scripts").join(file))
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
fn info() -> Value {
    let webkit = Command::new("pkg-config")
        .args(["--modversion", "webkit2gtk-4.1"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let env: HashMap<&str, String> = [
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
        "GDK_BACKEND",
        "__NV_PRIME_RENDER_OFFLOAD",
    ]
    .into_iter()
    .filter_map(|k| std::env::var(k).ok().map(|v| (k, v)))
    .collect();
    json!({
        "shell": "tauri",
        "variant": std::env::var("SPIKE_VARIANT").unwrap_or_else(|_| "tauri".into()),
        "autorun": std::env::var("SPIKE_AUTORUN").as_deref() == Ok("1"),
        "pid": std::process::id(),
        "launchMs": std::env::var("SPIKE_LAUNCH_MS").ok().and_then(|v| v.parse::<f64>().ok()),
        "versions": { "tauri": tauri::VERSION, "webkitgtk": webkit },
        "env": env,
    })
}

#[tauri::command]
fn load_fixture(name: String) -> Result<String, String> {
    if name.contains('/') {
        return Err("bad fixture name".into());
    }
    std::fs::read_to_string(root().join("fixtures").join(name)).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_result(name: String, data: Value) -> Result<String, String> {
    let dir = root().join("results");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let file = dir.join(format!("{safe}.json"));
    std::fs::write(&file, serde_json::to_string_pretty(&data).unwrap()).map_err(|e| e.to_string())?;
    Ok(file.display().to_string())
}

#[tauri::command(async)]
fn memory() -> Result<Value, String> {
    let out = run_script("mem.py", &[&std::process::id().to_string()])?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn keep_above(window: WebviewWindow, on: bool) -> Result<String, String> {
    let title = window.title().map_err(|e| e.to_string())?;
    run_script(
        "kwin-keep-above.sh",
        &[&std::process::id().to_string(), &title, if on { "true" } else { "false" }],
    )
}

#[tauri::command]
async fn open_capture(app: AppHandle, mode: String, auto_hide: bool) -> Result<(), String> {
    open_capture_impl(&app, &mode, auto_hide)
}

#[tauri::command]
fn report_frame(window: WebviewWindow, state: State<Spike>, ts: f64) {
    let recv = wall_now();
    let label = window.label().to_string();
    let Some(p) = state.pending.lock().unwrap().remove(&label) else {
        return;
    };
    state.timings.lock().unwrap().push(Timing {
        label,
        mode: p.mode.clone(),
        ms: ts - p.t0,
        rtt_ms: recv - p.t0,
    });
    if p.auto_hide {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            if p.mode == "warm" {
                let _ = window.hide();
            } else {
                let _ = window.destroy();
            }
        });
    }
}

#[tauri::command]
fn capture_timings(state: State<Spike>) -> Vec<Timing> {
    state.timings.lock().unwrap().clone()
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn start_socket(app: AppHandle) {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let path = PathBuf::from(dir).join("scratchpad-spike.sock");
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("socket bind failed: {e}");
            return;
        }
    };
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let mut parts = line.split_whitespace();
                let cmd = parts.next().unwrap_or("");
                if let Some(token) = parts.next() {
                    eprintln!("socket: {cmd} (activation token {token})");
                }
                let r = match cmd {
                    "capture" => open_capture_impl(&app, "warm", false),
                    "capture-cold" => open_capture_impl(&app, "cold", false),
                    "quit" => {
                        app.exit(0);
                        Ok(())
                    }
                    _ => Ok(()),
                };
                if let Err(e) = r {
                    eprintln!("socket command {cmd} failed: {e}");
                }
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Spike::default())
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(title_for("main"))
                .inner_size(1100.0, 900.0)
                .build()?;
            build_capture(app, "capture-warm", false)?;
            start_socket(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == "capture-warm" => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Destroyed if window.label() == "main" => window.app_handle().exit(0),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            info,
            load_fixture,
            save_result,
            memory,
            keep_above,
            open_capture,
            report_frame,
            capture_timings,
            quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
