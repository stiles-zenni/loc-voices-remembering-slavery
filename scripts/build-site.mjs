// Build the site's data from the library: one contents file plus one file per interview,
// with every part's phrases placed on a single continuous timeline.
//
//   node scripts/build-site.mjs
//
// Reads library/manifest.json, library/aligned/*.json and library/aligned/_report.json.
// Writes site-data/index.json and site-data/<sessionId>.json.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const LIB = path.join(ROOT, 'library');
const OUT = path.join(ROOT, 'site-data');

// Below this share of directly matched words, the contents page marks a sync as approximate.
const APPROXIMATE_BELOW = 0.5;

// Display names drop the "Aunt"/"Uncle" honorifics in the catalogue titles; the full Library
// of Congress title is still shown on each interview's intro card.
const EDITORIAL = {
  'phoebe-boyd-1935': { name: 'Phoebe Boyd', with: ['Archibald A. Hill', 'Guy S. Lowman', 'Mrs. John F. Ware'] },
  'wallace-quarterman-1935': { name: 'Wallace Quarterman', with: ['Zora Neale Hurston', 'Alan Lomax', 'Mary Elizabeth Barnicle'] },
  'unidentified-petersburg-1937': { name: 'Unidentified speakers', with: ['Roscoe E. Lewis'] },
  'joe-mcdonald-1940': { name: 'Joe McDonald', with: ['John A. Lomax', 'Ruby T. Lomax'] },
  'bob-ledbetter-1940': { name: 'Bob Ledbetter', with: ['John A. Lomax', 'Ruby T. Lomax'] },
  'alice-gaston-1941': { name: 'Alice Gaston', with: ['Robert Sonkin'] },
  'harriet-smith-1941': { name: 'Harriet Smith', with: ['John Henry Faulk'] },
  'george-johnson-1941': { name: 'George Johnson', with: ['Charles S. Johnson', 'Lewis Wade Jones', 'John W. Work', 'Alan Lomax', 'Elizabeth Lyttleton Sturz'] },
  'isom-moseley-1941': { name: 'Isom Moseley', with: ['Robert Sonkin'] },
  'laura-smalley-1941': { name: 'Laura Smalley', with: ['John Henry Faulk'] },
  'fountain-hughes-1949': { name: 'Fountain Hughes', with: ['Hermond Norwood'] },
  'charlie-smith-1975': { name: 'Charlie Smith', with: ['Elmer E. Sparks'] },
};

const roman = n => [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  .reduce((acc, [v, s]) => { while (n >= v) { acc += s; n -= v; } return acc; }, '');
const r2 = x => Math.round(x * 100) / 100;

const manifest = JSON.parse(fs.readFileSync(path.join(LIB, 'manifest.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(LIB, 'aligned', '_report.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const contents = [];
manifest.sessions.forEach((s, i) => {
  const ed = EDITORIAL[s.id] ?? { name: s.interviewee, with: [] };
  let offset = 0, anchored = 0, words = 0;
  const parts = [], phrases = [];
  for (const p of s.parts) {
    const file = path.join(LIB, 'aligned', `${p.itemId}.json`);
    if (!fs.existsSync(file)) throw new Error(`missing alignment for ${p.itemId}; run scripts/align.mjs`);
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    parts.push({ part: p.part, itemId: p.itemId, audio: `library/audio/${p.itemId}.mp3`, remoteAudio: p.audioUrl, locUrl: p.locUrl, offset: r2(offset), duration: a.duration });
    for (const ph of a.phrases) {
      phrases.push({
        ...ph, part: parts.length - 1, start: r2(ph.start + offset), end: r2(ph.end + offset),
        words: ph.words.map(w => ({ ...w, start: r2(w.start + offset), end: r2(w.end + offset) })),
      });
    }
    offset += a.duration;
    anchored += report[p.itemId]?.anchored ?? 0;
    words += report[p.itemId]?.transcriptWords ?? 0;
  }
  const matchRate = words ? anchored / words : 0;
  const entry = {
    id: s.id, numeral: roman(i + 1), name: ed.name, place: s.place, date: s.date, year: s.year,
    with: ed.with, duration: r2(offset), parts: parts.length, approximate: matchRate < APPROXIMATE_BELOW,
  };
  contents.push(entry);
  fs.writeFileSync(path.join(OUT, `${s.id}.json`), JSON.stringify({ ...entry, title: s.title, matchRate: r2(matchRate), partList: parts, phrases }));
});

// Each interview links to the next, so the player can offer it at the end.
const index = { collection: manifest.collection, collectionUrl: manifest.collectionUrl, source: manifest.source, interviews: contents };
contents.forEach((c, i) => {
  const file = path.join(OUT, `${c.id}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = contents[i + 1];
  data.next = next ? { id: next.id, name: next.name, place: next.place, date: next.date } : null;
  fs.writeFileSync(file, JSON.stringify(data));
});
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`wrote ${contents.length} interviews to ${path.relative(ROOT, OUT)}/`);
for (const c of contents) console.log(`  ${c.numeral.padEnd(5)} ${c.name.padEnd(22)} ${Math.round(c.duration / 60)} min${c.approximate ? '  (approximate)' : ''}`);
