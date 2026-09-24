# Shell test results

Generated 2026-09-24T01:16:24.060Z from the newest run of each variant.

| variant | launch → first frame (ms) | page → first frame (ms) | keystroke JS p95 (ms) | typing frame p50 / p95 (ms) | typing fps | scroll frame p50 / p95 (ms) | scroll fps | jump p95 (ms) | 100KB paste (ms) | capture warm p50 (ms) | capture cold p50 (ms) | memory PSS (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tauri-nodmabuf | 397 | 110 | 6.0 | 13.2 / 16.4 | 85 | 15.0 / 17.0 | 69 | 96 | 49 | 9.6 | 154 | 419 |
| tauri-nocompositing | 439 | 113 | 6.2 | 13.2 / 16.8 | 85 | 15.0 / 17.0 | 69 | 96 | 48 | 18.5 | 158 | 432 |
| electron-wayland | 384 | 223 | 3.3 | 4.2 / 5.1 | 229 | 4.2 / 4.3 | 236 | 38 | 47 | 14.8 | 93 | 582 |
| electron-x11 | 444 | 307 | 3.0 | 4.2 / 4.3 | 232 | 4.2 / 4.3 | 236 | 35 | 44 | 8.2 | 84 | 521 |
