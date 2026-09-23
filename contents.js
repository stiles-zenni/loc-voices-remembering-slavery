(() => {
  const toc = document.getElementById('toc');
  const minutes = s => `${Math.max(1, Math.round(s / 60))} min`;
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

  fetch('site-data/index.json')
    .then(r => r.json())
    .then(({ interviews }) => {
      document.getElementById('count').textContent = WORDS[interviews.length] ?? interviews.length;
      const years = interviews.map(i => i.year);
      document.getElementById('span').textContent = `${Math.min(...years)} and ${Math.max(...years)}`;

      for (const i of interviews) {
        const li = document.createElement('li');
        li.innerHTML = `
          <a class="entry" href="interview.html?id=${encodeURIComponent(i.id)}">
            <span class="entry-num"></span>
            <span class="entry-main">
              <span class="entry-line">
                <span class="entry-name"></span>
                <span class="entry-leader" aria-hidden="true"></span>
                <span class="entry-place"></span>
                <span class="entry-time"></span>
              </span>
              <span class="entry-with"></span>
            </span>
          </a>`;
        li.querySelector('.entry-num').textContent = i.numeral;
        li.querySelector('.entry-name').textContent = i.name;
        // Keep the contents line short: "Fort Frederica, St. Simons Island, Georgia" → "St. Simons Island, Georgia".
        const place = i.place.split(',').map(s => s.trim()).slice(-2).join(', ');
        li.querySelector('.entry-place').textContent = `${place}, ${i.date}`;
        li.querySelector('.entry-time').textContent = minutes(i.duration);
        const withText = i.with.length > 2 ? `With ${i.with[0]} and others` : i.with.length ? `With ${i.with.join(' and ')}` : '';
        const w = li.querySelector('.entry-with');
        w.textContent = withText;
        if (i.approximate) {
          const note = document.createElement('em');
          note.className = 'entry-approx';
          note.textContent = 'sync approximate';
          w.append(withText ? ' · ' : '', note);
        }
        toc.appendChild(li);
      }
    });
})();
