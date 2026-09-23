(() => {
  const root = document.getElementById('glossary');
  const index = document.getElementById('gloss-index');
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  fetch('site-data/glossary.json')
    .then(r => r.json())
    .then(({ groups }) => {
      for (const g of groups) {
        const section = el('section', 'gloss-group');
        section.appendChild(el('h2', 'gloss-group-title', g.title));

        for (const e of g.entries) {
          const link = el('a', null, e.term);
          link.href = `#${e.id}`;
          index.appendChild(link);

          const art = el('article', 'gloss-entry');
          art.id = e.id;
          const head = el('header', 'gloss-head');
          head.appendChild(el('h3', 'gloss-term', e.term));
          if (e.variants) head.appendChild(el('p', 'gloss-variants', e.variants));
          head.appendChild(el('p', 'gloss-meta', e.meta));
          art.appendChild(head);

          const body = el('div', 'gloss-body');
          for (const p of e.body) body.appendChild(el('p', null, p));

          if (e.moments.length) {
            const list = el('ul', 'gloss-moments');
            list.setAttribute('aria-label', `Hear “${e.term}”`);
            for (const m of e.moments) {
              const li = el('li');
              const a = el('a', 'moment');
              a.href = `interview.html?id=${encodeURIComponent(m.session)}&t=${m.start}`;
              const where = el('span', 'moment-where');
              // Moments spoken by an interviewer name them: "John Henry Faulk, to Harriet Smith".
              const who = m.speaker ? `${m.speaker}, to ${m.name}` : m.name;
              where.textContent = `${who} · ${m.sides > 1 ? `side ${m.side} · ` : ''}${fmt(m.sideTime)}`;
              a.append(el('span', 'moment-icon', '▸'), where, el('span', 'moment-quote', `“${m.quote}”`));
              li.appendChild(a);
              list.appendChild(li);
            }
            body.appendChild(list);
          }
          art.appendChild(body);
          section.appendChild(art);
        }
        root.appendChild(section);
      }
      const reading = el('a', null, 'Reading this edition');
      reading.href = '#reading';
      index.appendChild(reading);

      // Arriving at glossary.html#term: scroll once the entries exist.
      if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
    });
})();
