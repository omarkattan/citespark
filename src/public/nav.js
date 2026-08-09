/**
 * The mobile menu.
 *
 * The header used to wrap onto two rows on a phone because the sign-in button
 * would not fit beside the links. Rather than hide navigation until someone
 * scrolls to the footer, everything lives behind one control.
 */
(function () {
  const toggle = document.getElementById('navToggle');
  const menu = document.getElementById('navMenu');
  if (!toggle || !menu) return;

  const setOpen = (open) => {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('is-open', open);
    // Stop the page scrolling behind an open menu.
    document.body.classList.toggle('nav-open', open);
  };

  toggle.addEventListener('click', () => setOpen(menu.hidden));

  // Tapping a link, tapping outside, or Escape all close it.
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (!menu.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  // Returning to a wide screen must not leave the menu stuck open.
  const wide = window.matchMedia('(min-width: 861px)');
  wide.addEventListener('change', (e) => e.matches && setOpen(false));
})();
