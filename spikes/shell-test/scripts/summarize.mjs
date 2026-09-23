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

const f1 = (x) => (x == null ? '–' : Number(x).toFixed(1));
const f0 = (x) => (x == null ? '–' : Number(x).toFixed(0));
const pct = (s) => (s?.dropped == null ? '–' : `${((100 * s.dropped) / s.n).toFixed(1)}%`);

const rows = [...latest.values()].map((r) => {
  const t = r.typing ?? {};
  const avg = (k) => {
    const xs = Object.values(t).map((x) => x[k].p95);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const worstDropped = Object.values(t).reduce((a, x) => a + (x.frame.dropped ?? 0), 0);
  const typedFrames = Object.values(t).reduce((a, x) => a + x.frame.n, 0);
  return [
    r.info.variant,
    f1(r.refreshMs),
    f0(r.load?.navToFirstFrameMs),
    f0(r.load?.launchToFirstFrameMs),
    f1(r.load?.fixtureIpcMs),
    f1(avg('dispatch')),
    f1(avg('frame')),
    typedFrames ? `${((100 * worstDropped) / typedFrames).toFixed(1)}%` : '–',
    f1(t.table?.frame.p95),
    f1(r.scroll?.frame.p95),
    pct(r.scroll?.frame),
    f0(r.jumps?.p95),
    f0(r.paste?.settledMs),
    f1(r.captureWarm?.ms.p50),
    f0(r.captureCold?.ms.p50),
    f0(r.memory?.totalPssMb),
  ];
});

const header = [
  'variant',
  'refresh ms',
  'load: nav→frame ms',
  'load: launch→frame ms',
  'fixture IPC ms',
  'typing dispatch p95',
  'typing frame p95',
  'typing dropped',
  'table typing frame p95',
  'scroll frame p95',
  'scroll dropped',
  'jump p95 ms',
  '100KB paste ms',
  'capture warm p50 ms',
  'capture cold p50 ms',
  'memory PSS MB',
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
