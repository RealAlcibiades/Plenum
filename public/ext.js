// Loads the extra panels after the main page script. Each panel adds itself through window.MuseUI.
// The panels in KNOWN load first, in this order. Any other ext-*.js panel the server lists (GET /api/ext-modules) loads
// after them, sorted by name. If that list cannot be read, only the KNOWN panels load.
(function () {
  // Keep this order: the panels were written to load in it. ext-legal and ext-notices come first: the agreement card must be
  // ready before any panel asks the server for anything, and the notice registry must exist before a panel calls MuseUI.risk.
  const KNOWN = ['ext-legal', 'ext-notices', 'ext-accounts-api', 'ext-openrouter', 'ext-tools', 'ext-projects', 'ext-history', 'ext-compare', 'ext-prompts', 'ext-checkpoints', 'ext-plan', 'ext-cost', 'ext-images', 'ext-pipelines', 'ext-setup'];
  // The same shape the server accepts, so a name that reaches a URL is always a plain panel name.
  const NAME = /^ext-[a-z0-9-]{1,40}$/;

  // Names the server lists, or [] when the list cannot be read.
  // The request carries the Plenum token (MuseUI.request), so it waits until the page has looked for the token (MuseUI.ready).
  // Without MuseUI nothing can be asked, and only the KNOWN panels load.
  async function discovered() {
    try {
      if (!window.MuseUI?.request) return [];
      await (window.MuseUI.ready ?? Promise.resolve());
      const res = await window.MuseUI.request('/api/ext-modules', {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.modules) ? data.modules.filter(n => typeof n === 'string' && NAME.test(n)) : [];
    } catch {
      return [];
    }
  }

  function load(name) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/' + name + '.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = '/' + name + '.js';
    js.async = false;
    document.body.append(js);
  }

  discovered().then(found => {
    const extra = found.filter(name => !KNOWN.includes(name)).sort();
    for (const name of [...KNOWN, ...extra]) load(name);
  });
})();
