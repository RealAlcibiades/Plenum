// Sidebar menu for narrow windows. At 860 px and below the sidebar is hidden, so this panel adds a menu button at the left
// of the top bar. The button slides the same sidebar over the chat, with a scrim behind it. Adds itself through
// window.MuseUI. Layout and colour are in ext-sidebar.css. Nothing here changes the sidebar's own markup or its handlers.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without the page parts, there is nothing to attach to.
  if (!MuseUI) return;

  const sidebar = document.querySelector('.sidebar');
  const topbar = document.querySelector('.topbar');
  const app = document.getElementById('app');
  const badge = document.getElementById('updatesBadge');
  if (!sidebar || !topbar || !app || !badge) return;

  // The same breakpoint the stylesheet uses, so the menu and the layout switch together.
  const narrow = window.matchMedia('(max-width: 860px)');
  const OPEN = 'ext-side-open';

  if (!sidebar.id) sidebar.id = 'sidebar';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'icon-btn ext-side-toggle';
  toggle.setAttribute('aria-label', 'Open the menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', sidebar.id);
  // Marks that Updates has something to review while the menu is closed.
  const dot = document.createElement('span');
  dot.className = 'ext-side-dot';
  dot.hidden = true;
  toggle.append(MuseUI.icon('list'), dot);
  topbar.prepend(toggle);

  // Inside the sidebar, after the brand. It shows only while the menu is open.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn ext-side-close';
  closeBtn.setAttribute('aria-label', 'Close the menu');
  closeBtn.append(MuseUI.icon('x'));
  const brand = sidebar.querySelector('.brand');
  if (brand) brand.after(closeBtn);
  else sidebar.prepend(closeBtn);

  const scrim = document.createElement('div');
  scrim.className = 'ext-side-scrim';
  scrim.hidden = true;
  scrim.setAttribute('aria-hidden', 'true');
  app.append(scrim);

  function isOpen() {
    return document.body.classList.contains(OPEN);
  }

  function openMenu() {
    if (isOpen() || !narrow.matches) return;
    document.body.classList.add(OPEN);
    toggle.setAttribute('aria-expanded', 'true');
    scrim.hidden = false;
    // Start at the first project, or at the + button when there are none, so a keyboard user lands inside the menu.
    const first = sidebar.querySelector('.proj-item') || document.getElementById('addProjectBtn');
    if (first) first.focus();
  }

  // Focus goes back to the menu button, unless the window was widened (then the button is hidden and focus is left alone).
  function closeMenu(restoreFocus = true) {
    if (!isOpen()) return;
    document.body.classList.remove(OPEN);
    toggle.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
    if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => {
    if (isOpen()) closeMenu();
    else openMenu();
  });
  closeBtn.addEventListener('click', () => closeMenu());
  scrim.addEventListener('click', () => closeMenu());

  // Escape closes the menu only while it is open.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) closeMenu();
  });

  // Choosing a project or a link closes the menu. The listener runs in the capture phase, so a .forget button that stops
  // its click from bubbling still counts. The close waits one tick, so the click's own handler runs first.
  sidebar.addEventListener('click', e => {
    if (isOpen() && e.target.closest && e.target.closest('.side-link, .proj-item, .forget')) setTimeout(() => closeMenu(), 0);
  }, true);
  // A project row also opens from the keyboard, so Enter and Space on it close the menu the same way.
  sidebar.addEventListener('keydown', e => {
    if (isOpen() && (e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.proj-item')) setTimeout(() => closeMenu(), 0);
  }, true);

  // Widening the window past the breakpoint puts the normal sidebar back.
  narrow.addEventListener('change', () => {
    if (!narrow.matches) closeMenu(false);
  });

  // A drawer (Accounts, Updates, the Commands list and the like) opens over the chat, so the menu closes first and the two
  // never stack. Focus is left where the drawer put it.
  if (MuseUI.el.drawer) {
    new MutationObserver(() => {
      if (!MuseUI.el.drawer.hidden) closeMenu(false);
    }).observe(MuseUI.el.drawer, { attributes: true, attributeFilter: ['hidden'] });
  }

  // The dot follows the Updates badge: shown when the badge is shown, and titled with its count.
  function syncDot() {
    dot.hidden = badge.hidden;
    const count = badge.textContent.trim();
    dot.title = count === '1' ? '1 update to review' : `${count} updates to review`;
  }
  new MutationObserver(syncDot).observe(badge, {
    attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true,
  });
  syncDot();
})();
