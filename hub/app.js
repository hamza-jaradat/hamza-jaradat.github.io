// Search and tag filtering for the game grid (the build only adds the toolbar once there are 4+ games).
const grid = document.getElementById('grid');
const search = document.getElementById('search');

if (grid && search) {
  const cards = [...grid.querySelectorAll('.card')];
  const chips = [...document.querySelectorAll('.chip')];
  const noMatch = document.getElementById('no-match');
  let tag = '';

  const apply = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      const match =
        (!query || card.dataset.search.includes(query)) && (!tag || card.dataset.tags.split('|').includes(tag));
      card.hidden = !match;
      if (match) shown++;
    }
    noMatch.hidden = shown > 0;
  };

  search.addEventListener('input', apply);
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      tag = chip.dataset.tag;
      for (const c of chips) {
        c.classList.toggle('active', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
      }
      apply();
    });
  }
}
