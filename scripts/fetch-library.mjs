// Download the audio (and transcripts, if missing) for every part in library/manifest.json.
// Files already present at the expected size are skipped, so this is safe to re-run.
//
//   node scripts/fetch-library.mjs            fetch everything missing
//   node scripts/fetch-library.mjs --dry-run  list what would be fetched

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const LIB = path.join(ROOT, 'library');
const manifest = JSON.parse(fs.readFileSync(path.join(LIB, 'manifest.json'), 'utf8'));
const dry = process.argv.includes('--dry-run');

const jobs = [];
for (const s of manifest.sessions) {
  for (const p of s.parts) {
    jobs.push({ url: p.transcriptUrl, file: path.join(LIB, 'transcripts', `${p.itemId}.xml`) });
    jobs.push({ url: p.audioUrl, file: path.join(LIB, 'audio', `${p.itemId}.mp3`), bytes: p.audioBytes });
  }
}

const have = j => fs.existsSync(j.file) && (!j.bytes || fs.statSync(j.file).size === j.bytes);
const todo = jobs.filter(j => !have(j));
const mb = todo.reduce((a, j) => a + (j.bytes || 0), 0) / 1e6;
console.log(`${jobs.length - todo.length}/${jobs.length} files present; ${todo.length} to fetch (~${mb.toFixed(0)} MB)`);
if (dry) { for (const j of todo) console.log('  ' + path.relative(ROOT, j.file)); process.exit(0); }

let failed = 0;
for (const [i, j] of todo.entries()) {
  const tmp = j.file + '.part';
  try {
    const res = await fetch(j.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    if (j.bytes && fs.statSync(tmp).size !== j.bytes) throw new Error(`size ${fs.statSync(tmp).size} ≠ ${j.bytes}`);
    fs.renameSync(tmp, j.file);
    console.log(`[${i + 1}/${todo.length}] ${path.basename(j.file)}`);
  } catch (e) {
    failed++;
    fs.rmSync(tmp, { force: true });
    console.log(`[${i + 1}/${todo.length}] FAILED ${path.basename(j.file)}: ${e.message}`);
  }
}
console.log(failed ? `${failed} failed — re-run to retry.` : 'All files present.');
process.exit(failed ? 1 : 0);
