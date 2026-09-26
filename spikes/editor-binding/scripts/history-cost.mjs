// How much does stamping meta.modifiedAt add to a draft's history, and how
// much does compaction (a shallow snapshot) win back? Simulates a typing
// session: one commit per keystroke, with a few backspaces.
//
//   node scripts/history-cost.mjs [keystrokes]

import { LoroDoc } from 'loro-crdt';

const N = Number(process.argv[2] ?? 20000);
const words = 'the quick brown fox jumps over the lazy dog while drafts sync quietly'.split(' ');

function session(stampEvery) {
  const doc = new LoroDoc();
  const body = doc.getText('body');
  const meta = doc.getMap('meta');
  meta.set('schema', 1);
  meta.set('modifiedAt', 0);
  doc.commit();
  let typed = 0;
  let w = 0;
  while (typed < N) {
    const word = words[w++ % words.length] + ' ';
    for (const ch of word) {
      body.insert(body.length, ch);
      doc.commit({ origin: 'typing' });
      typed++;
      if (stampEvery && typed % stampEvery === 0) {
        meta.set('modifiedAt', typed);
        doc.commit({ origin: 'meta.stamp' });
      }
    }
    if (w % 7 === 0) {
      body.delete(body.length - 3, 3); // a few backspaces now and then
      doc.commit({ origin: 'typing' });
    }
  }
  const snapshot = doc.export({ mode: 'snapshot' }).length;
  const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() }).length;
  return { textChars: body.length, snapshotBytes: snapshot, shallowSnapshotBytes: shallow };
}

const rows = {
  'no stamps': session(0),
  'stamp every 20 keys (~2s of typing)': session(20),
  'stamp every key': session(1),
};
console.table(rows);

// Import cost for the 100k-word fixture, for comparison with the renderer.
const { readFileSync } = await import('node:fs');
const big = new LoroDoc();
big.getText('body').insert(0, readFileSync(new URL('../fixtures/large.md', import.meta.url), 'utf8'));
big.commit();
const bytes = big.export({ mode: 'snapshot' });
const t0 = performance.now();
const copy = new LoroDoc();
copy.import(bytes);
console.log(`100k-word snapshot: ${bytes.length} bytes, import ${(performance.now() - t0).toFixed(1)}ms in Node`);
