#!/usr/bin/env python3
"""Load-test a scratchpadd release build in a throwaway data directory.

Creates N ordinary drafts plus one 100k-word draft, then times the calls the
app and agents make most. Usage: scripts/load-test.py [N] (default 2000).
"""

import base64, json, os, random, shutil, socket, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAEMON = os.path.join(ROOT, "target", "release", "scratchpadd")
FIXTURE = os.path.join(ROOT, "spikes", "editor-binding", "fixtures", "large.md")
N = int(sys.argv[1]) if len(sys.argv) > 1 else 2000


class Conn:
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(path)
        self.f = self.s.makefile("rwb")
        self.id = 0

    def call(self, method, params=None):
        self.id += 1
        self.f.write((json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params or {}}) + "\n").encode())
        self.f.flush()
        while True:
            msg = json.loads(self.f.readline())
            if msg.get("id") == self.id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]


def timed(label, fn, repeat=20):
    samples = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        result = fn()
        samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    print(f"  {label:<44} p50 {samples[len(samples)//2]:7.2f} ms   p95 {samples[int(len(samples)*0.95)-1]:7.2f} ms")
    return result


def main():
    tmp = tempfile.mkdtemp(prefix="scratchpad-load-")
    env = dict(os.environ, SCRATCHPAD_DATA_DIR=os.path.join(tmp, "data"), SCRATCHPAD_SOCKET=os.path.join(tmp, "daemon.sock"))
    daemon = subprocess.Popen([DAEMON], env=env, stderr=subprocess.DEVNULL)
    try:
        for _ in range(200):
            if os.path.exists(env["SCRATCHPAD_SOCKET"]):
                break
            time.sleep(0.02)
        c = Conn(env["SCRATCHPAD_SOCKET"])
        big_text = open(FIXTURE).read()
        paragraphs = [p for p in big_text.split("\n\n") if len(p) > 40]
        rng = random.Random(7)

        t0 = time.perf_counter()
        for i in range(N):
            text = f"# Draft {i}\n\n" + "\n\n".join(rng.sample(paragraphs, rng.randint(1, 8)))
            c.call("drafts.create", {"text": text})
        elapsed = time.perf_counter() - t0
        print(f"created {N} drafts in {elapsed:.2f}s ({elapsed / N * 1000:.2f} ms each)")
        t0 = time.perf_counter()
        big = c.call("drafts.create", {"text": big_text})["id"]
        print(f"created the {len(big_text) // 1000} KB draft in {(time.perf_counter() - t0) * 1000:.1f} ms")

        print("timings:")
        timed("list inbox (100)", lambda: c.call("drafts.list", {"limit": 100}))
        timed("search common word ('the')", lambda: c.call("drafts.list", {"query": "the", "limit": 100}))
        timed("search two words", lambda: c.call("drafts.list", {"query": "sync latency", "limit": 20}))
        timed("search rare phrase", lambda: c.call("drafts.list", {"query": '"quietly patched"', "limit": 20}))
        timed("get small draft", lambda: c.call("drafts.get", {"id": c.call("drafts.list", {"limit": 1})["drafts"][0]["id"]}))
        detail = timed("get 680 KB draft", lambda: c.call("drafts.get", {"id": big}))
        timed("open 680 KB draft (snapshot)", lambda: c.call("doc.open", {"id": big}))
        timed("append to 680 KB draft", lambda: c.call("drafts.append", {"id": big, "text": " more"}))
        edited = detail["text"].replace("the", "THE", 1)
        timed("setText 680 KB draft, no base", lambda: c.call("drafts.setText", {"id": big, "text": edited}), repeat=10)
        timed(
            "setText 680 KB draft, with base",
            lambda: c.call("drafts.setText", {"id": big, "text": edited + "!", "baseVersion": c.call("drafts.get", {"id": big})["version"]}),
            repeat=10,
        )
        timed("archive + restore 680 KB draft", lambda: (c.call("drafts.setState", {"id": big, "state": "archived"}), c.call("drafts.setState", {"id": big, "state": "inbox"})), repeat=10)
        timed("list right after an edit (flushes index)", lambda: (c.call("drafts.append", {"id": big, "text": "x"}), c.call("drafts.list", {"limit": 20})), repeat=10)

        status = c.call("daemon.status")
        rss = int(open(f"/proc/{daemon.pid}/status").read().split("VmRSS:")[1].split()[0]) // 1024
        db = sum(os.path.getsize(os.path.join(env["SCRATCHPAD_DATA_DIR"], f)) for f in os.listdir(env["SCRATCHPAD_DATA_DIR"]) if f.startswith("scratchpad.db"))
        print(f"daemon: {status['drafts']} drafts, {status['openDocs']} loaded, RSS {rss} MB, database {db / 1e6:.1f} MB")
        c.call("daemon.shutdown")
        daemon.wait(timeout=5)
        t0 = time.perf_counter()
        daemon = subprocess.Popen([DAEMON], env=env, stderr=subprocess.DEVNULL)
        while True:
            try:
                Conn(env["SCRATCHPAD_SOCKET"]).call("hello")
                break
            except OSError:
                time.sleep(0.005)
        print(f"cold start to first reply: {(time.perf_counter() - t0) * 1000:.0f} ms")
        c2 = Conn(env["SCRATCHPAD_SOCKET"])
        timed("first list after restart", lambda: c2.call("drafts.list", {"limit": 100}), repeat=5)
        c2.call("daemon.shutdown")
        daemon.wait(timeout=5)
    finally:
        if daemon.poll() is None:
            daemon.kill()
        shutil.rmtree(tmp, ignore_errors=True)


main()
