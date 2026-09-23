(() => {
  const $ = id => document.getElementById(id);
  const audio = $('audio');
  const linesEl = $('lines');
  const speakerEl = $('speaker');
  const playBtn = $('play');
  const scrub = $('scrub');
  const track = $('track');
  const fill = $('fill');
  const intro = $('intro');
  const ending = $('ending');

  const REST_AFTER = 1.5; // seconds of silence after a phrase before it softens away
  let data = null;
  let phrases = [];
  let parts = [];
  let cur = 0;            // index of the part loaded in <audio>
  let switching = false;  // true while moving between parts, so the UI doesn't flash "paused"
  let active = -2;        // index of the rendered phrase; -1 = nothing yet
  let wordEls = [];
  let faded = false;
  let preloaded = -1;

  const fmt = s => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const now = () => (parts[cur]?.offset ?? 0) + audio.currentTime;
  // Live, the audio streams from the Library of Congress; in local development it comes from
  // library/audio (add ?remote=1 locally to test the Library's copies).
  const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname) && !new URLSearchParams(location.search).has('remote');
  const srcOf = p => (LOCAL ? p.audio : p.remoteAudio);

  // Last phrase whose start is <= t.
  function phraseAt(t) {
    let lo = 0, hi = phrases.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (phrases[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function wordText(w) {
    // "???" marks speech the transcriber couldn't make out.
    return w.note && /^\?{3}/.test(w.text) ? 'unclear' : w.text;
  }

  function render(index) {
    for (const old of linesEl.querySelectorAll('.phrase:not(.is-leaving)')) {
      old.classList.add('is-leaving');
      setTimeout(() => old.remove(), 400);
    }
    wordEls = [];
    faded = false;
    active = index;
    if (index < 0) { speakerEl.classList.add('is-hidden'); return; }

    const p = phrases[index];
    const el = document.createElement('p');
    el.className = 'phrase';
    p.words.forEach((w, i) => {
      const span = document.createElement('span');
      span.className = 'w' + (w.note ? ' note' : '') + (w.uncertain ? ' uncertain' : '');
      span.textContent = wordText(w);
      el.appendChild(span);
      if (i < p.words.length - 1) el.appendChild(document.createTextNode(' '));
      wordEls.push(span);
    });
    linesEl.appendChild(el);

    const name = p.speaker || '';
    if (speakerEl.textContent !== name) {
      speakerEl.classList.add('is-hidden');
      setTimeout(() => { speakerEl.textContent = name; speakerEl.classList.toggle('is-hidden', !name); }, 200);
    } else {
      speakerEl.classList.toggle('is-hidden', !name);
    }
  }

  function update() {
    if (!data) return;
    const t = now();
    const index = phraseAt(t);
    if (index !== active) render(index);

    if (index >= 0) {
      const p = phrases[index];
      p.words.forEach((w, i) => {
        const el = wordEls[i];
        const spoken = t >= w.start;
        el.classList.toggle('spoken', spoken);
        el.classList.toggle('current', spoken && t < w.end && !w.note);
      });
      // In a long pause, let the finished phrase soften away rather than hang.
      const next = phrases[index + 1];
      const shouldFade = t > p.end + REST_AFTER && (!next || next.start > t);
      if (shouldFade !== faded) {
        faded = shouldFade;
        linesEl.querySelector('.phrase:not(.is-leaving)')?.classList.toggle('is-faded', faded);
      }
    }

    fill.style.width = `${(t / data.duration) * 100}%`;
    $('elapsed').textContent = fmt(t);
    scrub.setAttribute('aria-valuenow', Math.floor(t));
    if (parts.length > 1) $('side').textContent = `Side ${cur + 1} of ${parts.length}`;

    // Warm the next side's audio shortly before this one ends.
    const p = parts[cur];
    if (cur + 1 < parts.length && preloaded !== cur + 1 && t > p.offset + p.duration - 30) {
      preloaded = cur + 1;
      const warm = new Audio();
      warm.preload = 'auto';
      warm.src = srcOf(parts[cur + 1]);
    }
  }

  function loop() {
    update();
    if (!audio.paused || switching) requestAnimationFrame(loop);
  }

  // ---------- Parts ----------

  function loadPart(k, at, play) {
    switching = play;
    cur = k;
    audio.src = srcOf(parts[k]);
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = Math.min(at, audio.duration || at);
      if (play) audio.play().finally(() => { switching = false; });
      else update();
    }, { once: true });
    if (play) requestAnimationFrame(loop);
  }

  function seek(t) {
    t = Math.min(Math.max(0, t), data.duration - 0.05);
    let k = parts.findIndex(p => t < p.offset + p.duration);
    if (k < 0) k = parts.length - 1;
    showEnding(false);
    if (k === cur) { audio.currentTime = t - parts[k].offset; update(); }
    else loadPart(k, t - parts[k].offset, !audio.paused);
  }

  audio.addEventListener('ended', () => {
    if (cur + 1 < parts.length) loadPart(cur + 1, 0, true);
    else { update(); showEnding(true); }
  });

  function showEnding(on) {
    ending.hidden = !on;
    document.body.classList.toggle('ended', on);
  }

  // ---------- Controls ----------

  const toggle = () => (audio.paused ? audio.play() : audio.pause());
  playBtn.addEventListener('click', toggle);
  audio.addEventListener('play', () => {
    playBtn.classList.add('is-playing');
    playBtn.setAttribute('aria-label', 'Pause');
    showEnding(false);
    requestAnimationFrame(loop);
  });
  audio.addEventListener('pause', () => {
    if (switching) return;
    playBtn.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Play');
    document.body.classList.remove('idle');
  });
  audio.addEventListener('seeked', update);

  let dragging = false;
  const seekFromPointer = e => {
    const r = track.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * data.duration);
  };
  scrub.addEventListener('pointerdown', e => { dragging = true; scrub.setPointerCapture(e.pointerId); seekFromPointer(e); });
  scrub.addEventListener('pointermove', e => { if (dragging) seekFromPointer(e); });
  scrub.addEventListener('pointerup', () => { dragging = false; });

  document.addEventListener('keydown', e => {
    if (!document.body.classList.contains('started')) return;
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seek(now() + 5); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seek(now() - 5); }
  });

  // Dim the chrome while listening; bring it back on any movement.
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!audio.paused) document.body.classList.add('idle'); }, 3000);
  };
  ['pointermove', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, wake, { passive: true }));

  $('from-start').addEventListener('click', e => {
    e.preventDefault();
    loadPart(0, 0, false);
    $('begin').click();
  });

  $('begin').addEventListener('click', () => {
    intro.classList.add('is-gone');
    document.body.classList.add('started');
    audio.play();
    wake();
  });

  // ---------- Load ----------

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  // ?t=<seconds> opens the interview at that moment, paused until the listener begins.
  const startAt = Math.max(0, Number(params.get('t')) || 0);
  if (!id) { location.replace('index.html'); return; }

  fetch(`site-data/${encodeURIComponent(id)}.json`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(d => {
      data = d;
      phrases = d.phrases;
      parts = d.partList;
      const when = `${d.place}, ${d.date}`;
      document.title = `${d.name} · Visualizing Voices`;
      $('masthead-who').textContent = `${d.name} · ${when}`;
      $('intro-kicker').textContent = `Voices Remembering Slavery · ${d.numeral}`;
      $('intro-title').textContent = d.name;
      $('intro-meta').textContent = when + (parts.length > 1 ? ` · ${parts.length} sides` : '');
      $('intro-with').textContent = d.with.length ? `With ${listNames(d.with)}` : '';
      $('intro-approx').hidden = !d.approximate;
      $('intro-source').textContent = `${d.title}.`;
      $('intro-link').href = parts[0].locUrl;
      $('intro-credit').textContent = d.credit;
      for (const a of document.querySelectorAll('.transcript-link')) a.href = `read/${encodeURIComponent(d.id)}.html`;
      $('total').textContent = fmt(d.duration);
      scrub.setAttribute('aria-valuemax', Math.floor(d.duration));
      if (d.next) {
        $('next').href = `interview.html?id=${encodeURIComponent(d.next.id)}`;
        $('next-name').textContent = d.next.name;
        $('next-meta').textContent = `${d.next.place}, ${d.next.date}`;
      } else {
        $('next').hidden = true;
      }
      if (startAt) {
        const k = Math.max(0, parts.findIndex(p => startAt < p.offset + p.duration));
        loadPart(k, startAt - parts[k].offset, false);
        const side = parts.length > 1 ? `side ${k + 1}, ` : '';
        $('begin').textContent = `Listen from ${side}${fmt(startAt - parts[k].offset)}`;
        $('from-start').hidden = false;
      } else {
        loadPart(0, 0, false);
      }
    })
    .catch(() => {
      $('intro-title').textContent = 'Interview not found';
      $('begin').hidden = true;
    });

  function listNames(names) {
    return names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }
})();
