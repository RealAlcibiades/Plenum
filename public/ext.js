// Loads the extra panels after the main page script. Each panel adds itself through window.MuseUI.
// The panels in KNOWN load first, in this order, as soon as the server's list has been asked for once. Any other ext-*.js panel the
// server lists (GET /api/ext-modules) loads after them, sorted by name. If that list cannot be read, it is asked for once more after
// 3 seconds; only the extra panels wait for that.
(function () {
  // Keep this order: the panels were written to load in it. ext-legal and ext-notices come first: the agreement card must be
  // ready before any panel asks the server for anything, and the notice registry must exist before a panel calls MuseUI.risk.
  // ext-remote comes next: its title-bar chip is a floor item, so it loads with the known panels.
  const KNOWN = ['ext-legal', 'ext-notices', 'ext-remote', 'ext-accounts-api', 'ext-openrouter', 'ext-tools', 'ext-projects', 'ext-history', 'ext-compare', 'ext-prompts', 'ext-checkpoints', 'ext-plan', 'ext-cost', 'ext-images', 'ext-pipelines', 'ext-setup'];
  // The same shape the server accepts, so a name that reaches a URL is always a plain panel name.
  const NAME = /^ext-[a-z0-9-]{1,40}$/;

  // Names the server lists. null when the list cannot be read (a request that fails or is refused, or an answer of the wrong shape),
  // and [] for a real empty list. Without MuseUI nothing can be asked, so that is [].
  // The request carries the Plenum token (MuseUI.request), so it waits until the page has looked for the token (MuseUI.ready).
  async function discovered() {
    try {
      if (!window.MuseUI?.request) return [];
      await (window.MuseUI.ready ?? Promise.resolve());
      const res = await window.MuseUI.request('/api/ext-modules', {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.modules) ? data.modules.filter(n => typeof n === 'string' && NAME.test(n)) : null;
    } catch {
      return null;
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

  const extrasOf = names => names.filter(name => !KNOWN.includes(name)).sort();
  // The KNOWN panels load when the first answer is in, whatever it is. The extra panels load from that answer, or, when the first
  // answer could not be read, from the second one (asked for 3 seconds later).
  discovered().then(first => {
    for (const name of KNOWN) load(name);
    if (first !== null) {
      for (const name of extrasOf(first)) load(name);
      return;
    }
    setTimeout(() => {
      discovered().then(again => {
        for (const name of extrasOf(again ?? [])) load(name);
      });
    }, 3000);
  });
})();
