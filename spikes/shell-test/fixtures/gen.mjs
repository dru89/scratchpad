// Generates a deterministic markdown fixture (default ~100k words) with the
// structures the editor has to render: headings, inline marks, links, lists,
// quotes, fenced code, many small/medium tables, and one 300-row table.
//
//   node fixtures/gen.mjs [words] [outfile]

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = Number(process.argv[2] ?? 100_000);
const OUT = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), 'large.md');

let seed = 0x5eed;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const WORDS = `the of and to in a is that for it as was with be by on not this are or from at which but have an they you were
their has would when if so no what up out who them some could into its then two more these time only may other about than first
any like new also after most people over such make can well where much should through back years way because each just those
work between both life being under never day same another know while last might great old year off come since against go came
right used take three states himself few house use during without again place around however home small found thought went
say part once general high upon school every does among often left number course water service less least important system
draft note idea sync device window editor table column latency render buffer cursor inbox archive trash scratch outline
sketch reply question answer meeting plan review launch migrate schema client server token cache layer mesh deploy`.split(/\s+/);

let words = 0;
const w = () => pick(WORDS);

function sentence() {
  const n = int(6, 22);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    let x = w();
    if (r < 0.03) x = `**${x} ${w()}**`;
    else if (r < 0.06) x = `*${x}*`;
    else if (r < 0.08) x = '`' + x + '()`';
    else if (r < 0.095) x = `[${x} ${w()}](https://example.com/${x}/${int(1, 999)})`;
    else if (r < 0.1) x = `~~${x}~~`;
    parts.push(x);
  }
  words += n;
  const s = parts.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + pick(['.', '.', '.', '.', '?', '!']);
}

const paragraph = () => Array.from({ length: int(2, 7) }, sentence).join(' ');

function list() {
  const ordered = rand() < 0.3;
  const lines = [];
  const n = int(3, 8);
  for (let i = 0; i < n; i++) {
    lines.push(`${ordered ? `${i + 1}.` : '-'} ${sentence()}`);
    if (!ordered && rand() < 0.15) lines.push(`  - ${sentence()}`);
  }
  return lines.join('\n');
}

const quote = () => `> ${paragraph()}`;

function code() {
  const lines = ['```ts'];
  const n = int(5, 15);
  for (let i = 0; i < n; i++) {
    const indent = '  '.repeat(int(0, 2));
    lines.push(`${indent}const ${w()}${int(1, 99)} = ${w()}(${w()}, ${int(0, 1000)}); // ${w()} ${w()}`);
  }
  lines.push('```');
  words += n * 5;
  return lines.join('\n');
}

function cell() {
  const r = rand();
  if (r < 0.25) return String(int(0, 99999));
  if (r < 0.35) return '`' + w() + '`';
  if (r < 0.42) return `**${w()}**`;
  return Array.from({ length: int(1, 4) }, w).join(' ');
}

function table(cols, rows) {
  const aligns = Array.from({ length: cols }, () => pick([':---', '---', '---:', ':---:']));
  const out = [
    `| ${Array.from({ length: cols }, () => w()).join(' | ')} |`,
    `| ${aligns.join(' | ')} |`,
  ];
  for (let r = 0; r < rows; r++) out.push(`| ${Array.from({ length: cols }, cell).join(' | ')} |`);
  words += cols * (rows + 1) * 2;
  return out.join('\n');
}

const blocks = ['# Scratchpad shell-test fixture', '', paragraph()];
let section = 0;
let bigTableDone = false;

while (words < TARGET) {
  section++;
  blocks.push(`## ${section}. ${sentence().replace(/[.?!]$/, '')}`);
  const n = int(6, 16);
  for (let i = 0; i < n && words < TARGET; i++) {
    const r = rand();
    if (!bigTableDone && words > TARGET / 2) {
      blocks.push(table(8, 300));
      bigTableDone = true;
    } else if (r < 0.58) blocks.push(paragraph());
    else if (r < 0.7) blocks.push(list());
    else if (r < 0.75) blocks.push(quote());
    else if (r < 0.81) blocks.push(code());
    else if (r < 0.87) blocks.push(table(int(3, 7), int(3, 30)));
    else if (r < 0.95) blocks.push(`### ${sentence().replace(/[.?!]$/, '')}`);
    else if (r < 0.96) blocks.push('---');
    else blocks.push(paragraph());
  }
}

const text = blocks.join('\n\n') + '\n';
writeFileSync(OUT, text);
const tables = (text.match(/^\| [^\n]*\n\| [:-]/gm) ?? []).length;
console.log(`wrote ${OUT}: ~${words} words, ${text.length} chars, ${tables} tables`);
