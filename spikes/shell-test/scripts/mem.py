#!/usr/bin/env python3
"""Sum PSS and RSS for a process and all of its descendants. Prints JSON.

PSS splits shared pages between the processes sharing them, so it is the
fairest single number for "how much memory does this app cost".
"""

import json
import os
import sys


def ppid_map():
    children = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as f:
                stat = f.read()
        except OSError:
            continue
        # comm can contain spaces and parens; fields after the last ')' are fixed.
        fields = stat[stat.rindex(")") + 2 :].split()
        children.setdefault(int(fields[1]), []).append(int(entry))
    return children


def read_kb(pid, path, keys):
    out = {}
    try:
        with open(f"/proc/{pid}/{path}") as f:
            for line in f:
                name, _, rest = line.partition(":")
                if name in keys:
                    out[name] = int(rest.split()[0])
    except OSError:
        pass
    return out


def main():
    root = int(sys.argv[1])
    children = ppid_map()
    pids, stack = [], [root]
    while stack:
        pid = stack.pop()
        if pid == os.getpid():
            continue  # don't count this script
        pids.append(pid)
        stack.extend(children.get(pid, []))

    procs = []
    for pid in pids:
        try:
            with open(f"/proc/{pid}/comm") as f:
                comm = f.read().strip()
        except OSError:
            continue
        smaps = read_kb(pid, "smaps_rollup", {"Pss", "Rss"})
        status = read_kb(pid, "status", {"VmRSS"})
        procs.append(
            {
                "pid": pid,
                "comm": comm,
                "pssKb": smaps.get("Pss"),
                "rssKb": smaps.get("Rss", status.get("VmRSS")),
            }
        )

    print(
        json.dumps(
            {
                "totalPssMb": round(sum(p["pssKb"] or 0 for p in procs) / 1024, 1),
                "totalRssMb": round(sum(p["rssKb"] or 0 for p in procs) / 1024, 1),
                "pssUnreadable": [p["comm"] for p in procs if p["pssKb"] is None],
                "processes": procs,
            }
        )
    )


main()
