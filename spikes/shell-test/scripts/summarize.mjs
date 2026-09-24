// Reads results/*.json, keeps the newest run per variant, and writes
// results/SUMMARY.md.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const latest = new Map();
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  latest.set(r.info.variant, r);
}

const f0 = (x) => (x == null ? '–' : Number(x).toFixed(0));
const f1 = (x) => (x == null ? '–' : Number(x).toFixed(1));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fps = (s) => (s ? f0(1000 / s.mean) : '–');

// Older results counted mem.py itself; leave it out either way.
const pss = (m) => m && m.processes.filter((p) => p.comm !== 'python3').reduce((a, p) => a + (p.pssKb ?? 0), 0) / 1024;

const rows = [...latest.values()].map((r) => {
  const typing = Object.values(r.typing ?? {});
  const typingFrames = typing.map((t) => t.frame);
  return [
    r.info.variant,
    f0(r.load?.launchToFirstFrameMs),
    f0(r.load?.navToFirstFrameMs),
    f1(mean(typing.map((t) => t.dispatch.p95))),
    `${f1(mean(typingFrames.map((s) => s.p50)))} / ${f1(mean(typingFrames.map((s) => s.p95)))}`,
    f0(mean(typingFrames.map((s) => 1000 / s.mean))),
    `${f1(r.scroll?.frame.p50)} / ${f1(r.scroll?.frame.p95)}`,
    fps(r.scroll?.frame),
    f0(r.jumps?.p95),
    f0(r.paste?.settledMs),
    f1(r.captureWarm?.ms.p50),
    f0(r.captureCold?.ms.p50),
    f0(pss(r.memory)),
  ];
});

const header = [
  'variant',
  'launch → first frame (ms)',
  'page → first frame (ms)',
  'keystroke JS p95 (ms)',
  'typing frame p50 / p95 (ms)',
  'typing fps',
  'scroll frame p50 / p95 (ms)',
  'scroll fps',
  'jump p95 (ms)',
  '100KB paste (ms)',
  'capture warm p50 (ms)',
  'capture cold p50 (ms)',
  'memory PSS (MB)',
];

const md = [
  '# Shell test results',
  '',
  `Generated ${new Date().toISOString()} from the newest run of each variant.`,
  '',
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
  '',
].join('\n');

writeFileSync(join(dir, 'SUMMARY.md'), md);
console.log(md);
