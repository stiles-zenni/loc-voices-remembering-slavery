// Batch build step: for every recording in library/manifest.json, transcribe the MP3 with
// Whisper (word timestamps) and align those words to the official Library of Congress
// transcript, so the site can show the LoC wording with per-word timing.
//
//   node scripts/align.mjs                  align every part not yet done (resumable)
//   node scripts/align.mjs --only <id>      one part (itemId) or session (session id)
//   node scripts/align.mjs --force          redo parts that already have output
//   node scripts/align.mjs --reuse          reuse cached Whisper output, only re-align
//   node scripts/align.mjs --cpu            transcribe on CPU (transformers.js) instead of the GPU
//   node scripts/align.mjs --threads 8      CPU threads per model with --cpu (default: half the cores)
//
// Output per part: library/aligned/<itemId>.json. Whisper output is cached in
// library/asr/<itemId>.json. A summary of every part lands in library/aligned/_report.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const LIB = path.join(ROOT, 'library');
const DIRS = { audio: 'audio', transcripts: 'transcripts', asr: 'asr', aligned: 'aligned' };
for (const k in DIRS) DIRS[k] = path.join(LIB, DIRS[k]);
const REPORT = path.join(DIRS.aligned, '_report.json');
const LOG = path.join(DIRS.aligned, '_run.log');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const THREADS = Number(opt('--threads')) || Math.max(1, Math.floor(os.cpus().length / 2));
const ENGINE = flag('--cpu') || !fs.existsSync(path.join(ROOT, 'tools', 'whisper', 'bin', 'Release', 'whisper-cli.exe')) ? 'cpu' : 'gpu';

function log(line) {
  console.log(line);
  fs.appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`);
}

// ---------- 1. Transcript ----------

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function parseTranscript(file, { speakerAliases = {}, noteLabels = [] }) {
  const xml = fs.readFileSync(file, 'utf8');
  const body = xml.slice(xml.indexOf('<text'));
  const title = decodeEntities(xml.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
  const turns = [];
  for (const [, inner] of body.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    if (/<hi rend="bold">/.test(inner)) continue; // tape id, title, END OF SIDE A
    const text = decodeEntities(inner.replace(/<hi rend="italics">([\s\S]*?)<\/hi>/g, '$1').replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ').trim();
    if (!text || /^END OF (SIDE|TAPE)/i.test(text)) continue;
    // "Speaker: text" (some transcripts omit the space after the colon).
    // "[Mrs. Jessie (?)]: …" marks a speaker the transcriber wasn't sure of; keep the "(?)".
    const unsure = text.match(/^\[\s*([A-Z][^\]:]{1,60}?)\s*\(\?\)\s*\]:\s*(.*)$/);
    const m = unsure ? [text, unsure[1], unsure[2]] : text.match(/^([A-Z][^:]{1,60}):\s*(.*)$/);
    const label = m?.[1].trim();
    if (label && noteLabels.includes(label)) {
      turns.push({ speaker: turns.at(-1)?.speaker ?? '', words: [{ text: m[2], note: true }] });
      continue;
    }
    const speaker = label ? (speakerAliases[label] ?? label) + (unsure ? ' (?)' : '') : (turns.at(-1)?.speaker ?? '');
    turns.push({ speaker, words: tokenize(m ? m[2] : text) });
  }
  return { title, turns: turns.filter(t => t.words.length) };
}

function tokenize(text) {
  const words = [];
  // Bracketed editorial notes and "???" (unclear speech) become non-timed tokens.
  for (const part of text.split(/(\[[^\]]*\][.,;:!?]*|\?{3,}\s*[.,;:!?]*)/)) {
    if (!part.trim()) continue;
    // "[let's begin (?)]" is the transcriber's best guess at real speech: align it, flag it.
    const guess = part.match(/^\[\s*([^\]]*?)\s*\(\?\)\s*\]([.,;:!?]*)$/);
    if (guess?.[1]) {
      const ws = guess[1].split(/\s+/);
      ws.forEach((w, k) => words.push({ text: w + (k === ws.length - 1 ? guess[2] : ''), uncertain: true }));
      continue;
    }
    if (part.startsWith('[') || part.startsWith('???')) { words.push({ text: part.trim(), note: true }); continue; }
    for (const raw of part.trim().split(/\s+/)) {
      // "folks—celebrates" → "folks—", "celebrates"
      for (const w of raw.split(/(?<=—)(?=\S)/)) words.push({ text: w });
    }
  }
  return words;
}

// ---------- 2. Audio + ASR ----------

const SR = 16000, WIN = 30, HOP = 25;

async function decodeAudio16k(file) {
  const { MPEGDecoder } = await import('mpg123-decoder');
  const dec = new MPEGDecoder();
  await dec.ready;
  const { channelData: ch, sampleRate } = dec.decode(new Uint8Array(fs.readFileSync(file)));
  dec.free();
  const ratio = sampleRate / SR;
  const n = Math.floor(ch[0].length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) for (const c of ch) s += c[j];
    out[i] = s / ((b - a) * ch.length);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.9 / peak;
  return out;
}

// Whisper sometimes gets stuck repeating a phrase ("he didn't tell you no, he didn't…").
// Where an n-gram repeats back-to-back (3+ times, or 6+ for single words), keep one copy and
// carry on with the rest of the output.
function dropLoops(chunks) {
  const t = chunks.map(c => norm(c.text));
  const out = [];
  for (let i = 0; i < t.length;) {
    let skipTo = i;
    for (let n = 1; n <= 6 && skipTo === i; n++) {
      let reps = 1;
      while (i + (reps + 1) * n <= t.length &&
        t.slice(i + reps * n, i + (reps + 1) * n).join(' ') === t.slice(i, i + n).join(' ')) reps++;
      if (reps >= (n === 1 ? 6 : 3)) { out.push(...chunks.slice(i, i + n)); skipTo = i + reps * n; }
    }
    if (skipTo > i) i = skipTo; else out.push(chunks[i++]);
  }
  return out;
}

let models = null;
async function loadModels() {
  if (models) return models;
  const { pipeline } = await import('@huggingface/transformers');
  // Larger models are more accurate but blank some quiet/noisy windows that base.en hears,
  // so run all per window and keep whichever produced the most words.
  const names = ['Xenova/whisper-small.en', 'Xenova/whisper-medium.en', 'Xenova/whisper-base.en'];
  const session_options = { intraOpNumThreads: THREADS, interOpNumThreads: 1 };
  models = [];
  for (const m of names) models.push(await pipeline('automatic-speech-recognition', m, { dtype: 'fp32', session_options }));
  return models;
}

async function runAsr(audioFile, label) {
  const asrs = await loadModels();
  const audio = await decodeAudio16k(audioFile);
  const duration = audio.length / SR;

  const transcribe = async (from, to) => {
    const clip = audio.subarray(Math.floor(from * SR), Math.floor(to * SR));
    let best = [];
    for (const asr of asrs) {
      const r = await asr(clip, { return_timestamps: 'word' });
      const ws = dropLoops((r.chunks || []).filter(c => !/^\s*[\[(]/.test(c.text) && !/_AUDIO|\]$/.test(c.text)));
      if (ws.length > best.length * 1.15) best = ws;
    }
    return best.map(c => ({ ...c, timestamp: [c.timestamp[0] + from, (c.timestamp[1] ?? c.timestamp[0] + 0.3) + from] }));
  };

  const words = [];
  for (let ws = 0; ws < duration; ws += HOP) {
    const we = Math.min(duration, ws + WIN);
    let best = await transcribe(ws, we);
    // Sparse result (noisy stretch the models gave up on): retry in two halves.
    if (best.length < (we - ws) * 1.8) {
      const mid = (ws + we) / 2;
      const halves = [...await transcribe(ws, mid + 1), ...await transcribe(mid - 1, we)]
        .filter((c, k, arr) => !(k > 0 && c.timestamp[0] < arr[k - 1].timestamp[1] - 0.05));
      if (halves.length > best.length) best = halves;
    }
    // Each window "owns" the middle of its span so overlapping windows don't duplicate words.
    const ownFrom = ws === 0 ? 0 : ws + (WIN - HOP) / 2;
    const ownTo = we >= duration ? Infinity : ws + HOP + (WIN - HOP) / 2;
    for (const c of best) {
      const [s, e] = c.timestamp;
      const mid = (s + e) / 2;
      if (mid >= ownFrom && mid < ownTo) words.push({ text: c.text.trim(), start: +s.toFixed(2), end: +e.toFixed(2) });
    }
    if (process.stdout.isTTY) process.stdout.write(`\r  ${label}  ${we.toFixed(0)}/${duration.toFixed(0)}s  words=${words.length}   `);
    if (we >= duration) break;
  }
  if (process.stdout.isTTY) process.stdout.write('\n');
  return { duration, words };
}

// GPU path: whisper.cpp's CUDA build (tools/whisper). Word-level segments via -ml 1 -sow.
const WHISPER = path.join(ROOT, 'tools', 'whisper');
const WHISPER_CLI = path.join(WHISPER, 'bin', 'Release', 'whisper-cli.exe');

function whisperCpp(audioFile, model) {
  const out = path.join(os.tmpdir(), `vv-${process.pid}-${model}`);
  const cliArgs = ['-m', path.join(WHISPER, `ggml-${model}.bin`), '-f', audioFile,
    '-ml', '1', '-sow', '-mc', '0', '-dtw', model, '-oj', '-of', out, '-np'];
  return new Promise((resolve, reject) => {
    const p = spawn(WHISPER_CLI, cliArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => {
      if (code !== 0) return reject(new Error(`whisper-cli ${model} exited ${code}: ${err.slice(-300)}`));
      const json = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
      fs.rmSync(`${out}.json`, { force: true });
      resolve(dropLoops(json.transcription
        // Strip dialogue dashes; drop sound labels like "(chatter)" or "[BLANK_AUDIO]".
        .map(s => ({ text: s.text.trim().replace(/^-+\s*/, ''), start: s.offsets.from / 1000, end: s.offsets.to / 1000 }))
        .filter(w => w.text && !/[()[\]]/.test(w.text))));
    });
  });
}

async function runAsrGpu(audioFile, label) {
  if (process.stdout.isTTY) process.stdout.write(`  ${label}  transcribing on GPU…\r`);
  const main = await whisperCpp(audioFile, 'medium.en');
  const backup = await whisperCpp(audioFile, 'base.en');
  const duration = (await decodeAudio16k(audioFile)).length / SR;
  // Per 30s window, keep the medium model's words unless base heard clearly more
  // (medium sometimes goes silent on quiet or noisy stretches).
  const words = [];
  for (let ws = 0; ws < duration; ws += WIN) {
    const inWin = list => list.filter(w => w.start >= ws && w.start < ws + WIN);
    const a = inWin(main), b = inWin(backup);
    words.push(...(b.length > a.length * 1.3 + 3 ? b : a));
  }
  return { duration, words: words.map(w => ({ text: w.text, start: +w.start.toFixed(2), end: +w.end.toFixed(2) })) };
}

// ---------- 3. Alignment ----------

const NUM = { '12': 'twelve', '1': 'one', '2': 'two', '3': 'three', '6': 'six', '19th': 'nineteenth' };
const EQUIV = { whoop: 'whup', whip: 'whup', ta: 'to', uhhuh: 'uhhuh', mhm: 'hmm', mm: 'hmm', hm: 'hmm', niggers: 'niggas', gonna: 'going' };

function norm(w) {
  let s = w.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]/g, '');
  s = NUM[s] ?? s;
  return EQUIV[s] ?? s;
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function sim(a, b) {
  if (!a || !b) return -2;
  if (a === b) return 3;
  const r = 1 - lev(a, b) / Math.max(a.length, b.length);
  return r >= 0.6 ? 1 : -1;
}

// Needleman–Wunsch global alignment; returns map transcriptIndex → asrIndex.
function align(tw, aw) {
  const n = tw.length, m = aw.length, GAP = -1;
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const tb = new Uint8Array((n + 1) * W); // 0 diag, 1 up (skip transcript), 2 left (skip asr)
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; tb[i * W] = 1; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; tb[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = score[(i - 1) * W + j - 1] + sim(tw[i - 1], aw[j - 1]);
      const u = score[(i - 1) * W + j] + GAP;
      const l = score[i * W + j - 1] + GAP;
      const k = i * W + j;
      if (d >= u && d >= l) { score[k] = d; tb[k] = 0; }
      else if (u >= l) { score[k] = u; tb[k] = 1; }
      else { score[k] = l; tb[k] = 2; }
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const t = tb[i * W + j];
    if (t === 0) { if (sim(tw[i - 1], aw[j - 1]) > 0) map[i - 1] = j - 1; i--; j--; }
    else if (t === 1) i--;
    else j--;
  }
  return map;
}

function timeWords(turns, asr) {
  const flat = turns.flatMap(t => t.words);
  const timed = flat.filter(w => !w.note);
  const map = align(timed.map(w => norm(w.text)), asr.words.map(w => norm(w.text)));

  // Anchor matched words, dropping any that would run backwards in time.
  let last = -1;
  timed.forEach((w, i) => {
    const a = map[i] >= 0 ? asr.words[map[i]] : null;
    if (a && a.start >= last) {
      w.start = a.start;
      w.end = Math.min(a.end, a.start + 1.5);
      w.anchored = true;
      last = a.start;
    }
  });

  // Interpolate unmatched runs between anchors, weighted by word length.
  const gaps = [];
  let i = 0;
  while (i < timed.length) {
    if (timed[i].start != null) { i++; continue; }
    let j = i;
    while (j < timed.length && timed[j].start == null) j++;
    // Runs may borrow the tail of the previous word, since Whisper word ends run long.
    const fromOf = () => (i > 0 ? timed[i - 1].start + (timed[i - 1].end - timed[i - 1].start) * 0.5 : 0);
    const span = () => (j < timed.length ? timed[j].start : asr.duration) - fromOf();
    // A run squeezed into too little time usually means a neighboring anchor is wrong;
    // release neighbors until the run gets a readable pace.
    for (let widen = 0; span() < (j - i) * 0.1 && widen < 3; widen++) {
      if (i > 0) { i--; timed[i].start = timed[i].end = null; timed[i].anchored = false; }
      if (j < timed.length) { timed[j].start = timed[j].end = null; timed[j].anchored = false; j++; }
      while (j < timed.length && timed[j].start == null) j++;
    }
    const from = fromOf();
    if (i > 0) timed[i - 1].end = from;
    const to = j < timed.length ? timed[j].start : asr.duration;
    gaps.push({ words: j - i, from: +from.toFixed(1), to: +to.toFixed(1), text: timed.slice(i, Math.min(j, i + 8)).map(w => w.text).join(' ') });
    const weights = timed.slice(i, j).map(w => w.text.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = from;
    for (let k = i; k < j; k++) {
      const d = ((to - from) * weights[k - i]) / total;
      timed[k].start = t;
      timed[k].end = t + d;
      t += d;
    }
    i = j;
  }

  // Notes appear when the word before them is spoken.
  let prevEnd = 0;
  for (const w of flat) {
    if (w.note) { w.start = w.end = prevEnd; } else prevEnd = w.end;
  }

  const anchored = timed.filter(w => w.anchored).length;
  return {
    stats: {
      transcriptWords: timed.length,
      asrWords: asr.words.length,
      anchored,
      matchRate: timed.length ? +(anchored / timed.length).toFixed(3) : 0,
      longestGaps: gaps.sort((a, b) => b.words - a.words).slice(0, 5),
    },
  };
}

// ---------- 4. Phrases ----------

const ABBR = /^(Mr|Mrs|Dr|Ms|St)\.$/;

function buildPhrases(turns) {
  const phrases = [];
  for (const turn of turns) {
    let cur = [];
    const flush = () => { if (cur.length) phrases.push({ speaker: turn.speaker, words: cur }); cur = []; };
    for (let k = 0; k < turn.words.length; k++) {
      const w = turn.words[k];
      cur.push(w);
      const t = w.text, len = cur.filter(x => !x.note).length;
      const sentenceEnd = /[.?!]["”’]?$|—$/.test(t) && !ABBR.test(t) && !w.note;
      const clauseEnd = /[,;:]$/.test(t);
      const remaining = turn.words.length - k - 1;
      if ((sentenceEnd && len >= 3 && remaining !== 1) || (clauseEnd && len >= 12 && remaining > 3) || len >= 20) flush();
    }
    flush();
  }
  const r2 = x => Math.round(x * 100) / 100;
  return phrases.map(p => ({
    speaker: p.speaker,
    start: r2(p.words[0].start),
    end: r2(p.words[p.words.length - 1].end),
    words: p.words.map(w => ({ text: w.text, start: r2(w.start), end: r2(w.end), ...(w.note ? { note: true } : {}), ...(w.uncertain ? { uncertain: true } : {}) })),
  }));
}

// ---------- 5. Keep Windows awake while we run ----------

// Asks Windows not to sleep for as long as this process lives (same mechanism media players
// use). No system setting is changed; the request ends when the helper process exits.
function holdWakeLock() {
  if (process.platform !== 'win32') return () => {};
  const ps = `
    $sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';
    $k = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru;
    $null = $k::SetThreadExecutionState([uint32]"0x80000001");
    while ($true) { Start-Sleep -Seconds 60; if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { break } }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  const release = () => { try { child.kill(); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });
  return release;
}

// ---------- 6. Batch ----------

async function main() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(LIB, 'manifest.json'), 'utf8'));
  const only = opt('--only');
  const jobs = manifest.sessions.flatMap(s => s.parts.map(p => ({ session: s, part: p })))
    .filter(({ session, part }) => !only || session.id === only || part.itemId === only);
  const report = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
  const todo = jobs.filter(({ part }) => flag('--force') || flag('--reuse') || !fs.existsSync(path.join(DIRS.aligned, `${part.itemId}.json`)));

  log(`start: ${todo.length} of ${jobs.length} parts to align on ${ENGINE === 'gpu' ? 'GPU (whisper.cpp)' : `CPU, ${THREADS} threads per model`}`);
  if (!todo.length) return;
  const release = holdWakeLock();
  const t0 = Date.now();
  let failed = 0;

  for (const [n, { session, part }] of todo.entries()) {
    const label = `[${n + 1}/${todo.length}] ${session.id} pt ${part.part} (${part.itemId})`;
    const tPart = Date.now();
    try {
      const asrFile = path.join(DIRS.asr, `${part.itemId}.json`);
      let asr;
      if ((flag('--reuse') || !flag('--force')) && fs.existsSync(asrFile)) {
        asr = JSON.parse(fs.readFileSync(asrFile, 'utf8'));
      } else {
        const audioFile = path.join(DIRS.audio, `${part.itemId}.mp3`);
        asr = ENGINE === 'gpu' ? await runAsrGpu(audioFile, label) : await runAsr(audioFile, label);
        asr.engine = ENGINE;
        fs.writeFileSync(asrFile, JSON.stringify(asr));
      }
      const { title, turns } = parseTranscript(path.join(DIRS.transcripts, `${part.itemId}.xml`), manifest);
      const { stats } = timeWords(turns, asr);
      const phrases = buildPhrases(turns);
      fs.writeFileSync(path.join(DIRS.aligned, `${part.itemId}.json`), JSON.stringify({
        itemId: part.itemId, sessionId: session.id, part: part.part, title,
        duration: Math.round(asr.duration * 100) / 100, phrases,
      }));
      const secs = (Date.now() - tPart) / 1000;
      report[part.itemId] = {
        sessionId: session.id, part: part.part, difficulty: part.difficulty,
        audioSeconds: Math.round(asr.duration), processSeconds: Math.round(secs), ...stats,
        alignedAt: new Date().toISOString(),
      };
      fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
      log(`${label}  ok  ${(stats.matchRate * 100).toFixed(1)}% anchored, ${Math.round(asr.duration / 60)} min audio in ${Math.round(secs / 60)} min`);
    } catch (e) {
      failed++;
      log(`${label}  FAILED  ${e.stack?.split('\n').slice(0, 2).join(' | ') ?? e}`);
    }
  }

  release();
  log(`done: ${todo.length - failed} ok, ${failed} failed, ${Math.round((Date.now() - t0) / 60000)} min total`);
  process.exitCode = failed ? 1 : 0;
}

main();
