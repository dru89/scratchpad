# Development

How scratchpad is put together, and how to build, test and release it.

## How it fits together

- **The core** is a Rust daemon, `scratchpadd`. It owns the SQLite store and the Loro documents, and serves everything else over one local socket with JSON-RPC. The CLI and the desktop app start it when they need it.
- **The CLI**, `scratchpad`, is a client of that socket, and `scratchpad mcp` is an MCP server over stdio for agents.
- **The desktop app** is Electron, chosen after the [shell test](../spikes/shell-test/). Each window edits its own Loro copy of its draft in CodeMirror 6 and syncs with the daemon the way devices will sync with a server, so typing never waits.
- **The editor** keeps the markdown text as the only source of truth and decorates it in place.

[`design.md`](design.md) has the details, including the protocol.

## Layout

- `crates/core/`: the draft model, SQLite store, titles, search, rendering and protocol types. It's a library so the iPhone app can embed it.
- `crates/daemon/`: `scratchpadd`.
- `crates/cli/`: `scratchpad`, including `scratchpad mcp`.
- `app/`: the Electron app. `electron/` is the main process and `src/` the windows.
- `docs/`: design, decisions, research and this file.
- `spikes/`: throwaway experiments that each answer one question.
- `scripts/`: the daemon load test.

## Building from source

You need Rust 1.89 or newer and Node.js 24. On macOS you also need the Xcode Command Line Tools.

```bash
cargo build --workspace
cd app && npm install && npm start
```

`npm start` builds the app and runs it from the checkout. It starts whichever `scratchpadd` is installed (in `~/.local/bin`, `~/.cargo/bin` or on the PATH); set `SCRATCHPAD_DAEMON=../target/debug/scratchpadd` to use the one you just built. `app/bin/scratchpad-app` runs an already built checkout, and `app/scripts/install-linux.sh` installs that as the Linux app (see the README).

## Tests

```bash
cargo test --workspace                          # unit tests, plus end-to-end tests of the real binaries
cargo build --release && scripts/load-test.py   # timings with 2,000 drafts and a 100k-word draft (Linux)
cd app && npm test                              # renderer unit tests
cd app && npm run test:e2e                      # the real app against a throwaway daemon (build the workspace first)
cd app && npm run test:e2e:headless             # the same on a virtual X display, so it doesn't take your focus (Linux)
```

The end-to-end suite drives the real app with Playwright, with the CLI standing in for agents and the hotkey. Set `SCRATCHPAD_E2E_APP` to a packaged app's executable to test that build, bundled CLI and daemon included, instead of the checkout.

## Packaging and releases

```bash
cargo build --release --bin scratchpadd --bin scratchpad
cd app && npm run package
```

electron-builder ([`app/electron-builder.yml`](../app/electron-builder.yml)) writes the app to `app/release`, with `scratchpadd` and `scratchpad` inside it under `Resources/bin`. On macOS it signs and notarizes when the signing variables are set.

CI ([`.github/workflows/build.yml`](../.github/workflows/build.yml)) runs every test on Linux and macOS. On macOS it then builds the app, signs and notarizes it (except for pull requests), checks the signature, runs the end-to-end suite against the packaged app, and uploads the `.dmg` and `.zip` as the run's artifacts. It needs these repository secrets:

| secret | what it is |
| --- | --- |
| `MAC_CERTIFICATE_BASE64` | A Developer ID Application certificate and its private key, exported as `.p12` and base64-encoded |
| `MAC_CERTIFICATE_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | The Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | The team the certificate belongs to |

To release, bump `version` in `app/package.json` and push a matching tag (`v0.2.0`). The tag's run publishes the macOS build as a GitHub Release.

## Environment variables

| variable | effect |
| --- | --- |
| `SCRATCHPAD_DATA_DIR` | Where the daemon keeps its data |
| `SCRATCHPAD_SOCKET` | The daemon's socket path |
| `SCRATCHPAD_DAEMON` | The `scratchpadd` binary that clients start |
| `SCRATCHPAD_APP` | The app that `scratchpad capture` and `scratchpad open` start when it isn't running |
| `SCRATCHPAD_APP_STATE_DIR` | Where the app keeps window state |
| `SCRATCHPAD_IDLE_MS` | The idle rollover time, in milliseconds |
| `SCRATCHPAD_E2E_APP` | A packaged app for the end-to-end tests to launch |
| `SCRATCHPAD_E2E_SCALE` | A device scale factor for test runs, for sharp screenshots |
| `SCRATCHPAD_SCREENSHOTS` | Where `test/screenshots.spec.ts` writes; unset, it's skipped |

The tests set the data, socket, daemon and app state variables so a run never touches your real drafts.

## Screenshots

`app/scripts/readme-screenshots.sh` regenerates the README's images in `docs/images` at 2x on a virtual display. `npm run screenshots` in `app/` rewrites the full set of windows and states in `docs/design-handoff/screenshots`, which is the "before" set from the visual design pass. To keep that set as it is, run `SCRATCHPAD_SCREENSHOTS=<dir> npx playwright test screenshots` after `npm run build` instead.
