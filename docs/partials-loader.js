async function loadPartials() {
  for (const host of document.querySelectorAll('[data-partial],[data-include]')) {
    const response = await fetch(host.dataset.partial || host.dataset.include);
    host.innerHTML = await response.text();
  }
  wireSubmenus();
}

function closeMenu(menu, { restoreFocus = false } = {}) {
  if (!menu.classList.contains('open')) return;
  menu.classList.remove('open');
  const button = menu.querySelector('button');
  button.setAttribute('aria-expanded', 'false');
  if (restoreFocus) button.focus();
}

function wireSubmenus() {
  for (const menu of document.querySelectorAll('.menu')) {
    const button = menu.querySelector('button');
    if (!button) continue;
    button.addEventListener('click', () => {
      const open = !menu.classList.contains('open');
      for (const other of document.querySelectorAll('.menu.open')) closeMenu(other);
      menu.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
    });
  }

  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('.menu.open')) {
      if (!menu.contains(event.target)) closeMenu(menu);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const menu of document.querySelectorAll('.menu.open')) closeMenu(menu, { restoreFocus: true });
  });
}

loadPartials();
