// Build the site's data from the library: one contents file plus one file per interview,
// with every part's phrases placed on a single continuous timeline.
//
//   node scripts/build-site.mjs           build site-data/ and read/ (transcript pages)
//   node scripts/build-site.mjs --dist    also copy the public site into dist/ (Netlify publishes it)
//
// Reads library/manifest.json, library/aligned/*.json, library/aligned/_report.json and
// library/glossary/glossary.json. Writes site-data/index.json, site-data/<sessionId>.json,
// site-data/glossary.json and one static transcript page per interview in read/.

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

// Credit lines as the Library asks: source collection, collection number, repository.
const COLLECTIONS = {
  afc1984011: 'American Dialect Society Collection, 1931-1937',
  afc1935001: 'Alan Lomax, Zora Neale Hurston, and Mary Elizabeth Barnicle Expedition Collection',
  afc1948015: 'Hampton Institute Duplication Project',
  afc1940003: 'John and Ruby Lomax 1940 Southern States Recordings Collection',
  afc1941018: 'Robert Sonkin Alabama and New Jersey Collection, 1937-1941',
  afc1941016: 'John Henry Faulk Recordings of Negro Religious Services',
  afc1941002: 'Library of Congress and Fisk University Mississippi Delta Collection, 1941-1943',
  afc1950037: 'Cyrus B. Koonce Collection',
  afc1975023: 'Elmer E. Sparks Interview with Charlie Smith',
};
function credit(itemId) {
  const key = itemId.split('_')[0];
  const number = `AFC ${key.slice(3, 7)}/${key.slice(7)}`;
  return `${COLLECTIONS[key] ?? 'Voices Remembering Slavery'} (${number}), American Folklife Center, Library of Congress`;
}

const roman = n => [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  .reduce((acc, [v, s]) => { while (n >= v) { acc += s; n -= v; } return acc; }, '');
const r2 = x => Math.round(x * 100) / 100;

const manifest = JSON.parse(fs.readFileSync(path.join(LIB, 'manifest.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(LIB, 'aligned', '_report.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
// Start clean, so interviews removed from the manifest disappear from the site too.
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.json')) fs.rmSync(path.join(OUT, f));

const contents = [];
// Sessions marked "excluded" in the manifest are kept on record but left out of the edition.
const sessions = manifest.sessions.filter(s => !s.excluded);
sessions.forEach((s, i) => {
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
    credit: credit(s.parts[0].itemId),
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

// Glossary: add each moment's interview name, side and time, and check the quote
// matches what the alignment has at that moment.
const GLOSSARY = path.join(LIB, 'glossary', 'glossary.json');
if (fs.existsSync(GLOSSARY)) {
  const glossary = JSON.parse(fs.readFileSync(GLOSSARY, 'utf8'));
  const cache = {};
  const load = id => (cache[id] ??= JSON.parse(fs.readFileSync(path.join(OUT, `${id}.json`), 'utf8')));
  const squash = s => s.toLowerCase().replace(/[^a-z]/g, '');
  let problems = 0;
  for (const g of glossary.groups) {
    for (const e of g.entries) {
      e.moments = e.moments.map(m => {
        const s = load(m.session);
        const ph = s.phrases.find(p => Math.abs(p.start - m.at) < 0.05);
        const said = ph ? squash(ph.words.filter(w => !w.note).map(w => w.text).join(' ')) : '';
        if (!ph || !said.includes(squash(m.quote).slice(0, 12))) {
          problems++;
          console.warn(`  glossary: "${e.term}" moment at ${m.at}s in ${m.session} doesn't match the transcript there`);
        }
        const part = s.partList[ph?.part ?? 0];
        return {
          ...m, name: s.name,
          side: (ph?.part ?? 0) + 1, sides: s.partList.length,
          sideTime: r2(m.at - part.offset),
          // Start a moment early so the phrase has a lead-in.
          start: r2(Math.max(0, m.at - 2)),
        };
      });
    }
  }
  delete glossary.note;
  fs.writeFileSync(path.join(OUT, 'glossary.json'), JSON.stringify(glossary));
  console.log(`glossary: ${glossary.groups.reduce((n, g) => n + g.entries.length, 0)} entries${problems ? `, ${problems} moment(s) to check` : ''}`);
}
console.log(`wrote ${contents.length} interviews to ${path.relative(ROOT, OUT)}/`);
for (const c of contents) console.log(`  ${c.numeral.padEnd(5)} ${c.name.padEnd(22)} ${Math.round(c.duration / 60)} min${c.approximate ? '  (approximate)' : ''}`);

// ---------- Static transcript pages (read/<id>.html) ----------
// The full text of each interview as plain HTML: for readers who can't or don't want to
// listen, for screen readers, and for search engines. Each paragraph links to its moment.

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const listNames = n => (n.length < 3 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`);

function wordHtml(w) {
  if (w.note) return `<span class="t-note">${/^\?{3}/.test(w.text) ? '[unclear]' : esc(w.text)}</span>`;
  if (w.uncertain) return `<em class="t-guess">${esc(w.text)}</em>`;
  return esc(w.text);
}

function head({ title, description }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="https://voices-remembering-slavery.netlify.app/share.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="“Well, I was about thirteen years old at the break up.” Harriet Smith, 1941. Voices Remembering Slavery.">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../styles.css">
</head>`;
}

const READ = path.join(ROOT, 'read');
fs.rmSync(READ, { recursive: true, force: true });
fs.mkdirSync(READ, { recursive: true });
for (const c of contents) {
  const s = JSON.parse(fs.readFileSync(path.join(OUT, `${c.id}.json`), 'utf8'));
  const listen = t => `../interview.html?id=${encodeURIComponent(c.id)}${t ? `&t=${r2(Math.max(0, t - 2))}` : ''}`;
  const sides = s.partList.map((p, k) => {
    // Merge consecutive phrases by the same speaker into one paragraph.
    const turns = [];
    for (const ph of s.phrases.filter(ph => ph.part === k)) {
      const last = turns.at(-1);
      if (last && last.speaker === ph.speaker) last.phrases.push(ph);
      else turns.push({ speaker: ph.speaker, phrases: [ph] });
    }
    const body = turns.map(t => {
      const at = t.phrases[0].start;
      const text = t.phrases.map(ph => ph.words.map(wordHtml).join(' ')).join(' ');
      return `      <div class="t-turn">
        <a class="t-time" href="${listen(at)}" aria-label="Listen from ${clock(at - p.offset)}">${clock(at - p.offset)}</a>
        <div>${t.speaker ? `<p class="t-speaker">${esc(t.speaker)}</p>` : ''}<p class="t-text">${text}</p></div>
      </div>`;
    }).join('\n');
    return `    <section class="t-side" id="side-${k + 1}">
      ${s.partList.length > 1 ? `<h2 class="gloss-group-title">Side ${k + 1} of ${s.partList.length}</h2>` : ''}
${body}
    </section>`;
  }).join('\n');

  const description = `Transcript of the interview with ${c.name}, ${c.place}, ${c.date}, from the Library of Congress's Voices Remembering Slavery collection.`;
  fs.writeFileSync(path.join(READ, `${c.id}.html`), `${head({ title: `${c.name}: transcript · Visualizing Voices`, description })}
<body class="contents-page">
  <div class="paper" aria-hidden="true"></div>
  <header class="masthead">
    <span class="masthead-left"><a class="back" href="../index.html">← Contents</a><span class="masthead-title">Visualizing Voices</span></span>
    <span class="masthead-sub">From the collections of the Library of Congress</span>
  </header>
  <main class="book">
    <header class="book-head">
      <p class="intro-kicker">Transcript · ${c.numeral}</p>
      <h1 class="book-title">${esc(c.name)}</h1>
      <p class="book-subtitle">${esc(c.place)}, ${esc(c.date)}</p>
      ${c.with.length ? `<p class="t-with">With ${esc(listNames(c.with))}</p>` : ''}
      <p class="t-actions"><a class="begin" href="${listen(0)}">Listen to the interview</a></p>
    </header>
    <section class="foreword foreword-note">
      <p>${esc(s.title)}. The Library of Congress's transcript, which keeps the language of the recording. Times link to that moment in the audio. <span class="t-note">[unclear]</span> marks speech the transcriber could not make out; <em class="t-guess">italics</em>, their best guess.${c.approximate ? ' The timing for this recording is approximate.' : ''}</p>
      <p>${esc(c.credit)}. <a href="${esc(s.partList[0].locUrl)}">View at the Library of Congress</a>.</p>
    </section>
${sides}
    <footer class="colophon">
      <a href="../index.html">Contents</a> · <a href="../glossary.html">Notes on language</a>
    </footer>
    <footer class="site-footer">
      <p class="footer-integrity">The audio streams directly from the Library of Congress, unedited. The transcripts are the Library's own, with their wording unchanged.</p>
      <p class="footer-meta">An independent edition, not affiliated with or endorsed by the Library of Congress.<span class="footer-built">Built by Claude Opus 5.5 · <a href="../about.html">How this was made</a></span></p>
    </footer>
  </main>
</body>
</html>
`);
}
console.log(`read: ${contents.length} transcript pages`);

// ---------- Package the public site for Netlify ----------

if (process.argv.includes('--dist')) {
  const DIST = path.join(ROOT, 'dist');
  fs.rmSync(DIST, { recursive: true, force: true });
  const files = ['index.html', 'interview.html', 'glossary.html', 'about.html', 'contents.js', 'player.js', 'glossary.js', 'styles.css', 'favicon.svg', 'share.jpg'];
  fs.mkdirSync(DIST, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));
  for (const dir of ['site-data', 'read', 'fonts']) fs.cpSync(path.join(ROOT, dir), path.join(DIST, dir), { recursive: true });
  console.log(`dist: packaged ${files.length} files + site-data/ + read/ + fonts/`);
}
