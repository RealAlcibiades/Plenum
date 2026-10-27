// In-page checks for the phone layer (MOBILE-UI.md section 16.1), mob-18. This is a classic script, not a module: the harness injects it
// into a page with window.eval or executeJavaScript (phone-window.mjs: evalFile), and it then defines globalThis.plenumPhoneChecks.
//   await h.evalFile('mobile/test/helpers/phone-checks.js');  // from the harness: installs the helpers in the page
//   await h.eval('plenumPhoneChecks.audit()');                // { hOverflow, small, smallNames, targets }
// Every helper reads the page only; none of them changes it.
(function () {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight;
  };
  const targets = () => [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [tabindex="0"]')]
    .filter(visible)
    .filter(el => !el.closest('.turn-body p, .risk-note-text p, .ext-review-lines'));
  const small = () => targets().filter(el => {
    const r = el.getBoundingClientRect();
    return r.width < 43.5 || r.height < 43.5;
  });
  const hOverflow = () => document.scrollingElement.scrollWidth > innerWidth + 0.5;
  const nameOf = el => (el.getAttribute('aria-label') || el.textContent || '').trim() ||
    (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() : '');
  const hittable = el => {
    const r = el.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!t && (t === el || el.contains(t));
  };
  // A summary for reports: what is too small and what overflows. The phone checks in MOBILE-UI 16.2 decide pass or fail.
  const audit = () => {
    const bad = small();
    return {
      hOverflow: hOverflow(),
      targets: targets().length,
      small: bad.length,
      smallNames: bad.slice(0, 12).map(el => nameOf(el).slice(0, 40)),
    };
  };
  globalThis.plenumPhoneChecks = { visible, targets, small, hOverflow, nameOf, hittable, audit };
})();
