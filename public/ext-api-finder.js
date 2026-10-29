// ext-api-finder. Builds on window.MuseUI (see app.js).
// The API finder: a Settings section (scope app, after Accounts) that answers "where is this model cheapest, and how do I use it
// here?". It reads GET /api/finder, which the server answers from four public price lists (OpenRouter, Vercel AI Gateway, DeepInfra
// and Martian, read without a key). Nothing is read until the section is on screen. GET /api/finder/endpoints answers the providers
// behind one OpenRouter model. A model can be set as the model, tried once with /ask, or (for a direct provider) set directly, and the
// page links to Accounts to add a key. State lives in this module's memory only: no browser storage, no key, and every piece of text is
// set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const SECTION_ID = 'api-finder';
  const TITLE = 'API finder';
  const ORDER = 35;
  const LOAD_MS = 60_000;
  const ENDPOINTS_MS = 30_000;
  const INFO_MS = 8_000;
  const SEARCH_MS = 120;
  const PAGE = 50;
  const CLOCK_MS = 30_000;
  // MuseUI[LINK_HOOK](url) opens an https link in the Browser pane. Until that exists the 'Open links in' control is not drawn.
  const LINK_HOOK = 'openBrowser';
  // The LEGAL strip for this page (lib/notices.mjs id api-finder-prices). The page asks for it above the caveat.
  const NOTICE_ID = 'api-finder-prices';

  const CAVEAT = 'Prices are per million tokens, before router fees, as each source publishes them. Direct prices come from Plenum\'s own table, checked 14 Oct 2026. They change often: check the source\'s own page before you rely on one.';
  const FOOTER = 'Read without a key: OpenRouter, Vercel AI Gateway, DeepInfra and Martian. Plenum reads them only while this panel is open, keeps each list for ten minutes and sends them no keys, chats or project files. A model a router names differently shows as its own row.';
  const ALL_FAILED = 'No router price list could be read. Only Plenum\'s own direct prices are shown. Check the internet connection, then press Refresh.';
  const FAILED_NOTE = 'The Routers tab needs this too, because the router list comes from Plenum\'s server.';

  const SOURCE_ORDER = ['openrouter', 'vercel', 'deepinfra', 'martian', 'direct'];
  const SOURCE_NAME = { openrouter: 'OpenRouter', vercel: 'Vercel AI Gateway', deepinfra: 'DeepInfra', martian: 'Martian' };
  const SOURCE_KIND = { openrouter: 'Router', vercel: 'Gateway', deepinfra: 'Inference host', martian: 'Router', direct: 'Direct, Plenum\'s price table' };
  const KIND_LABEL = { router: 'Router', gateway: 'Gateway', host: 'Inference host', cloud: 'Cloud platform', proxy: 'Self-hosted proxy', direct: 'Direct provider' };
  const PRICE_OPTIONS = [['any', 'Any price'], ['free', 'Free only'], ['p025', 'Input up to $0.25'], ['p1', 'Input up to $1'], ['p3', 'Input up to $3'], ['p10', 'Input up to $10']];
  const PRICE_LIMIT = { p025: 0.25, p1: 1, p3: 3, p10: 10 };
  const CONTEXT_OPTIONS = [[0, 'Any context'], [32000, '32K or more'], [128000, '128K or more'], [200000, '200K or more'], [1000000, '1M or more']];
  const SORT_OPTIONS = [['routers', 'Most widely offered'], ['blend', 'Cheapest for a typical chat'], ['input', 'Cheapest input'], ['output', 'Cheapest output'], ['context', 'Largest context'], ['name', 'Name A to Z']];
  const FILTER_DEFAULT = Object.freeze({ vendor: '', price: 'any', context: 0, tools: false, vision: false, usable: false });

  // ---------- small DOM helpers (textContent only) ----------

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  const sr = text => make('span', 'sr', text);
  const isHttps = url => typeof url === 'string' && /^https:\/\//.test(url);
  const ghost = (text, title) => {
    const b = MuseUI.button('ghost small', text);
    if (title) b.title = title;
    return b;
  };
  const primary = (text, title) => {
    const b = MuseUI.button('primary small', text);
    if (title) b.title = title;
    return b;
  };
  const need = text => make('span', 'af-need', text);

  // ---------- pure helpers (exported to tests as MuseUI.apiFinder) ----------

  // "$2" when whole, "$2.50", "$0.10", "$0.075", "$0.0075". 0 is "Free". A missing price is a dash.
  function priceText(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    if (n === 0) return 'Free';
    if (n >= 1) return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3).replace(/(\.\d\d)0$/, '$1')}`;
    return `$${n.toFixed(Math.min(20, 1 - Math.floor(Math.log10(n))))}`;
  }

  // 1000000 -> "1M", 1500000 -> "1.5M", 200000 -> "200K", 512 -> "512".
  function contextText(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    return String(n);
  }

  // The age of the oldest read, as the strip shows it.
  function ageText(at, now = Date.now()) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return '';
    if (now - at < 60_000) return '· just now';
    const mins = Math.floor((now - at) / 60_000);
    if (mins < 60) return mins === 1 ? '· 1 minute ago' : `· ${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    return hours === 1 ? '· 1 hour ago' : `· ${hours} hours ago`;
  }

  const timeText = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // "14 Oct 2026" from a YYYY-MM-DD string (read as UTC, so the day never shifts).
  function dateText(iso, withYear = true) {
    const d = new Date(`${String(iso)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return String(iso ?? '');
    const opts = withYear ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' };
    return d.toLocaleDateString('en-GB', opts);
  }

  // A time from today is "14:32"; any other day adds the date: "19 Oct, 22:10".
  function stampText(at, now = Date.now()) {
    const d = new Date(at);
    const t = new Date(now);
    const time = timeText(at);
    const today = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
    if (today) return time;
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`;
  }

  // "OpenRouter, Vercel AI Gateway and DeepInfra" from a list of names.
  function listNames(names) {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // Filters the rows. Every word of the query must appear in the name, id or vendor. A price limit uses the lowest input price.
  function filterRows(rows, query, f) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = PRICE_LIMIT[f.price];
    return rows.filter(row => {
      if (words.length) {
        const hay = `${row.name} ${row.id} ${row.vendor}`.toLowerCase();
        if (!words.every(w => hay.includes(w))) return false;
      }
      if (f.vendor && row.vendorKey !== f.vendor) return false;
      if (f.price === 'free' && row.best?.blend !== 0) return false;
      if (limit !== undefined && !(row.best && row.best.input <= limit)) return false;
      if (f.context > 0 && !(typeof row.context === 'number' && row.context >= f.context)) return false;
      if (f.tools && row.tools !== true) return false;
      if (f.vision && row.vision !== true) return false;
      if (f.usable && !(row.openrouterId || row.plenumRef)) return false;
      return true;
    });
  }

  // Sorts a copy of the rows. Missing values sort last.
  function sortRows(rows, sort) {
    const nullsLast = (get, dir = 1) => (a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir;
    };
    const blend = nullsLast(r => r.best?.blend ?? null);
    const comparers = {
      routers: (a, b) => b.offers.length - a.offers.length || blend(a, b),
      blend,
      input: nullsLast(r => r.best?.input ?? null),
      output: nullsLast(r => r.best?.output ?? null),
      context: nullsLast(r => (typeof r.context === 'number' ? r.context : null), -1),
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
    };
    return rows.slice().sort(comparers[sort] ?? comparers.routers);
  }

  // The name a source is called on the page: the router's own name, or the server's name for a feed.
  function sourceLabel(s) {
    return SOURCE_NAME[s.id] ?? s.name ?? s.id;
  }

  // The sentence under the strip. Returns '' when every source was read.
  function bannerFor(sources) {
    const failed = (sources ?? []).filter(s => s.ok === false);
    if (!failed.length) return '';
    if ((sources ?? []).every(s => !Number.isFinite(s.at))) return ALL_FAILED;
    const never = failed.filter(s => !(s.stale && Number.isFinite(s.at)));
    const stale = failed.filter(s => s.stale && Number.isFinite(s.at));
    let text = '';
    if (never.length) text = `${listNames(never.map(sourceLabel))} could not be read, so ${never.length === 1 ? 'its' : 'their'} prices are missing below`;
    if (stale.length) {
      // Sources read at the same time share one clause: "OpenRouter and DeepInfra show the list read at 14:32".
      const byTime = new Map();
      for (const s of stale) {
        const t = timeText(s.at);
        byTime.set(t, [...(byTime.get(t) ?? []), sourceLabel(s)]);
      }
      const clauses = [...byTime].map(([t, names]) => `${listNames(names)} ${names.length === 1 ? 'shows' : 'show'} the list read at ${t}`);
      text += `${text ? ', and ' : ''}${clauses.join('; ')}`;
    }
    return text ? `${text}.` : '';
  }

  // The sentence that follows a refresh: throttled, the sources that failed, or the time it was read.
  function refreshNoteFor(data, now = Date.now()) {
    if (data.throttled) return 'Plenum asked these sources less than a minute ago, so it did not ask again. Try Refresh again in a minute.';
    const failed = (data.sources ?? []).filter(s => s.ok === false);
    if (failed.length) return `${listNames(failed.map(sourceLabel))} could not be read. Older prices are shown where Plenum has them.`;
    return `Prices refreshed at ${timeText(now)}.`;
  }

  // The strip's headline. Only the four live sources count as "read"; the direct table never does.
  function headlineFor(data) {
    if (!data || !Number.isFinite(data.readAt)) return 'No prices read yet';
    if (!Number.isFinite(data.oldestAt) || data.readAt - data.oldestAt < 60_000) return `Prices read at ${stampText(data.readAt)}`;
    return `Prices read between ${stampText(data.oldestAt)} and ${stampText(data.readAt)}`;
  }

  const MODULE_EXPORTS = {
    priceText, contextText, ageText, timeText, dateText, stampText, listNames, filterRows, sortRows, bannerFor, refreshNoteFor, headlineFor,
    PAGE, FILTER_DEFAULT, SOURCE_ORDER,
  };

  // ---------- state (memory only; it survives closing and reopening the section) ----------

  const state = {
    data: null,
    error: '',
    loading: false,
    loadSeq: 0,
    note: '',
    readiness: {},
    tab: 'models',
    query: '',
    filters: { ...FILTER_DEFAULT },
    sort: 'routers',
    shown: PAGE,
    hits: 0,
    expanded: null,
    endpoints: new Map(),
    epOpen: new Set(),
    filtersOpen: false,
    linkTarget: 'system',
    scrollTop: 0,
    busy: '',
    pendingFocus: '',
    scrollToExpanded: false,
    focusSearch: false,
    refs: null,
    clock: 0,
    scrollBound: false,
    searchTimer: 0,
  };

  // ---------- data access ----------

  const sourceById = id => (state.data?.sources ?? []).find(s => s.id === id) ?? null;
  const routerFor = feed => (state.data?.directory?.routers ?? []).find(r => r.feed === feed) ?? null;
  const providerOf = ref => (ref.indexOf(':') < 0 ? '' : ref.slice(0, ref.indexOf(':')));
  // The reason a provider is not ready, or '' when it is ready or nothing is known yet.
  const needOf = provider => {
    const r = state.readiness[provider];
    return r && r.ready !== true ? String(r.why || 'Not ready') : '';
  };
  const readyOf = provider => state.readiness[provider]?.ready === true;

  function directName(provider) {
    const p = (state.data?.direct?.providers ?? []).find(x => x.id === provider);
    return p ? String(p.name).replace(/\s*\(.*\)$/, '') : provider;
  }

  // The name a source shows: its own name, or "<Provider> direct" for the direct offer of this row.
  function nameOf(source, row) {
    if (source !== 'direct') return SOURCE_NAME[source] ?? source;
    const offer = row?.offers?.find(o => o.source === 'direct');
    return `${directName(providerOf(String(offer?.id ?? '')))} direct`;
  }

  function sortedOffers(row) {
    return row.offers.slice().sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  }

  // ---------- network ----------

  async function call(path, timeoutMs) {
    const res = await MuseUI.request(path, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function errorText(err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'The price read did not finish in time. Try Refresh again.';
    return err?.message || 'The API finder could not load.';
  }

  // Reads the four price lists (or the server's copy). force asks the server to read them again, within its one-minute floor.
  async function load(force) {
    const seq = ++state.loadSeq;
    state.loading = true;
    paintFresh();
    if (!state.data) paintLists();
    try {
      const data = await call(`/api/finder${force ? '?refresh=1' : ''}`, LOAD_MS);
      if (seq !== state.loadSeq) return;
      state.data = data;
      state.error = '';
      state.loading = false;
      state.note = force ? refreshNoteFor(data) : '';
      paintAll();
    } catch (err) {
      if (seq !== state.loadSeq) return;
      state.loading = false;
      const message = errorText(err);
      if (state.data) {
        MuseUI.toast(message, 'bad');
        paintFresh();
      } else {
        state.error = message;
        paintAll();
      }
    }
  }

  // The readiness of each provider (GET /api/models/info). It adds no key-status code of its own.
  async function loadReadiness() {
    try {
      const data = await MuseUI.api('/api/models/info');
      if (data && data.readiness && typeof data.readiness === 'object') {
        state.readiness = data.readiness;
        paintLists();
      }
    } catch {
      // The page keeps the readiness it has.
    }
  }

  async function loadEndpoints(id) {
    state.endpoints.set(id, { state: 'loading', list: [], message: '' });
    paintModels();
    try {
      const data = await call(`/api/finder/endpoints?id=${encodeURIComponent(id)}`, ENDPOINTS_MS);
      if (data.ok === false) throw new Error(data.message || 'OpenRouter did not list its providers.');
      state.endpoints.set(id, { state: 'ok', list: Array.isArray(data.endpoints) ? data.endpoints : [], message: '' });
    } catch (err) {
      state.endpoints.set(id, { state: 'error', list: [], message: errorText(err) });
    }
    paintModels();
  }

  // ---------- actions ----------

  function resetView() {
    state.shown = PAGE;
    state.expanded = null;
  }

  function toggleRow(key) {
    state.expanded = state.expanded === key ? null : key;
    state.pendingFocus = `name:${key}`;
    state.scrollToExpanded = state.expanded !== null;
    paintModels();
  }

  async function runSet(key, action, message) {
    state.busy = key;
    paintModels();
    try {
      await action();
      MuseUI.toast(message);
    } catch (err) {
      MuseUI.toast(err?.message || 'The model could not be set.', 'bad');
    } finally {
      state.busy = '';
      state.pendingFocus = `name:${key}`;
      paintModels();
    }
  }

  // Sets the model to openrouter:<id>, adding it to the model menu first (as ext-openrouter.js does).
  // The model goes to the thread on screen, and the toast names that thread when it is not Main (B-98).
  const threadWord = () => {
    const t = MuseUI.threads?.info?.();
    return t && !t.main && t.name ? ` for ${t.name}` : '';
  };

  function useOpenRouter(row) {
    const ref = `openrouter:${row.openrouterId}`;
    const menu = MuseUI.el.model;
    if (menu && menu.options.length && ![...menu.options].some(o => o.value === ref)) menu.append(new Option(`OpenRouter · ${row.openrouterId}`, ref));
    return runSet(row.key, () => MuseUI.setThreadModel(ref), `Model set to ${row.name} (OpenRouter)${threadWord()}`);
  }

  function useDirect(row) {
    const name = MuseUI.modelName(row.plenumRef);
    return runSet(row.key, () => MuseUI.setThreadModel(row.plenumRef), `Model set to ${name}${threadWord()}`);
  }

  // The next message only goes to this model: the /ask prefix goes into the composer, and the drawer closes.
  function tryOnce(id) {
    if (!MuseUI.state.activeProject) return MuseUI.toast('Add a project folder first. Messages belong to a project.', 'bad');
    const input = MuseUI.el.input;
    const prefix = `/ask openrouter:${id} `;
    const existing = input.value;
    input.value = existing && !existing.startsWith('/') ? prefix + existing : prefix;
    input.dispatchEvent(new Event('input'));
    MuseUI.closeDrawer();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return undefined;
  }

  // The provider's card in Accounts. Claude's card sits outside the keys list, and OpenRouter's model card is its own section.
  function cardFor(provider, body) {
    if (provider === 'anthropic') return body.querySelector('.logo-sm.p-claude')?.closest('.card') ?? null;
    return body.querySelector(`.ext-apikeys .logo-sm.p-${provider}`)?.closest('.card')
      ?? body.querySelector(`.ext-${provider} .logo-sm.p-${provider}`)?.closest('.card')
      ?? null;
  }

  // Opens Accounts and scrolls to the provider's card, focusing its key box. It waits up to four seconds for the card. Accounts is
  // a group of the Settings page, whose sections are drawn into settingsContent.
  function openAccounts(provider) {
    MuseUI.el.accountsBtn.click();
    const body = MuseUI.el.settingsContent ?? MuseUI.el.drawerBody;
    const done = card => {
      card.scrollIntoView({ block: 'center' });
      const input = card.querySelector('input[type=password]') ?? card.querySelector('input');
      input?.focus();
    };
    const found = cardFor(provider, body);
    if (found) return done(found);
    const observer = new MutationObserver(() => {
      const card = cardFor(provider, body);
      if (!card) return;
      observer.disconnect();
      clearTimeout(timer);
      done(card);
    });
    observer.observe(body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), 4000);
    return undefined;
  }

  function openAccountsButton(provider) {
    const b = ghost('Open Accounts');
    b.addEventListener('click', () => openAccounts(provider));
    return b;
  }

  // ---------- painting: strip ----------

  function pillFor(s) {
    const name = sourceLabel(s);
    if (s.ok) return { tone: 'ok', text: `${name} · ${s.count}`, title: `${s.count} models, read at ${timeText(s.at)}` };
    if (s.stale && Number.isFinite(s.at)) return { tone: 'warn', text: `${name} · from ${timeText(s.at)}`, title: `${s.message || ''} Showing the list read at ${timeText(s.at)}.`.trim() };
    return { tone: 'bad', text: `${name} · not read`, title: s.message || 'Not read yet' };
  }

  function paintFresh() {
    const r = state.refs;
    if (!r) return;
    const d = state.data;
    r.headline.textContent = state.loading && !d ? 'Reading prices…' : headlineFor(d);
    r.age.textContent = d ? ageText(d.oldestAt) : '';
    r.pills.replaceChildren();
    if (d) {
      for (const s of d.sources) {
        const p = pillFor(s);
        const pill = make('span', p.tone === 'ok' ? 'pill ok' : p.tone === 'warn' ? 'pill warn' : p.tone === 'bad' ? 'pill bad' : 'pill', p.text);
        pill.title = p.title;
        pill.setAttribute('aria-hidden', 'true');
        r.pills.append(pill, sr(`${sourceLabel(s)}: ${p.title}`));
      }
      const table = make('span', 'pill', `Plenum table · ${dateText(d.direct.checkedOn, false)}`);
      table.title = `Direct provider prices from Plenum's own table, checked ${dateText(d.direct.checkedOn)}. Not read live.`;
      table.setAttribute('aria-hidden', 'true');
      r.pills.append(table, sr(`Plenum table, checked ${dateText(d.direct.checkedOn)}. Not read live.`));
    }
    r.refresh.disabled = state.loading;
    r.refresh.setAttribute('aria-busy', String(state.loading));
    if (state.loading) {
      const spin = make('span', 'spinner');
      spin.setAttribute('aria-hidden', 'true');
      r.refresh.replaceChildren(spin, document.createTextNode(' Refreshing…'));
    } else {
      r.refresh.textContent = 'Refresh';
    }
    r.note.textContent = state.note;
    paintWarn();
  }

  function paintAge() {
    const r = state.refs;
    if (r && state.data) r.age.textContent = ageText(state.data.oldestAt);
  }

  function paintWarn() {
    const r = state.refs;
    if (!r) return;
    const text = state.data ? bannerFor(state.data.sources) : '';
    r.warn.textContent = text;
    r.warn.hidden = !text;
  }

  function paintTabs() {
    const r = state.refs;
    if (!r) return;
    const d = state.data;
    r.tabModels.textContent = d ? `Models (${d.models.length})` : 'Models';
    r.tabRouters.textContent = d ? `Routers (${d.directory.routers.length + d.direct.providers.length})` : 'Routers';
    for (const [key, node] of [['models', r.tabModels], ['routers', r.tabRouters]]) {
      const on = state.tab === key;
      node.setAttribute('aria-selected', String(on));
      node.tabIndex = on ? 0 : -1;
    }
    r.modelsPane.hidden = state.tab !== 'models';
    r.routersPane.hidden = state.tab !== 'routers';
  }

  // ---------- painting: models ----------

  function filterCount() {
    const f = state.filters;
    return [f.vendor !== '', f.price !== 'any', f.context > 0, f.tools, f.vision, f.usable].filter(Boolean).length;
  }

  function paintFilterBar() {
    const r = state.refs;
    if (!r) return;
    const d = state.data;
    const f = state.filters;
    const vendors = d ? vendorList(d.models) : [];
    r.provider.replaceChildren(new Option('All providers', ''));
    for (const [key, v] of vendors) r.provider.append(new Option(`${v.name} (${v.count})`, key));
    r.provider.value = vendors.some(([key]) => key === f.vendor) ? f.vendor : '';
    r.price.value = f.price;
    r.context.value = String(f.context);
    r.sort.value = state.sort;
    // The box keeps what is typed (a space at the end included) unless the query itself changed.
    if (r.search.value.trim() !== state.query) r.search.value = state.query;
    for (const node of [r.search, r.provider, r.price, r.context, r.sort, ...r.chips.values()]) node.disabled = !d;
    r.chips.get('tools').setAttribute('aria-pressed', String(f.tools));
    r.chips.get('vision').setAttribute('aria-pressed', String(f.vision));
    r.chips.get('usable').setAttribute('aria-pressed', String(f.usable));
    const active = state.query !== '' || filterCount() > 0;
    r.clear.hidden = !active || !d;
    const n = filterCount();
    r.filterToggle.textContent = n ? `Filters · ${n}` : 'Filters';
    r.filterToggle.setAttribute('aria-expanded', String(state.filtersOpen));
    // The narrow panel shows this body only when it is open. A class is used, not the hidden attribute, so the wide layout can show it.
    r.filterBody.classList.toggle('af-open', state.filtersOpen);
    r.filterToggle.disabled = !d;
  }

  function vendorList(models) {
    const map = new Map();
    for (const row of models) {
      const e = map.get(row.vendorKey) ?? { name: row.vendor, count: 0 };
      e.count += 1;
      map.set(row.vendorKey, e);
    }
    return [...map].sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
  }

  function loadingBlock() {
    const wrap = make('div', 'af-loading-wrap');
    const line = make('div', 'af-loading');
    line.append(make('span', 'spinner'), make('span', 'thinking-text', 'Reading prices from OpenRouter, Vercel AI Gateway, DeepInfra and Martian…'));
    wrap.append(line, make('p', 'af-sub', 'The first read can take a few seconds.'));
    for (let i = 0; i < 6; i += 1) {
      const bar = make('div', 'af-skel');
      bar.setAttribute('aria-hidden', 'true');
      wrap.append(bar);
    }
    return wrap;
  }

  function errorCard() {
    const card = make('div', 'card af-error');
    const again = primary('Try again');
    again.addEventListener('click', () => load(false));
    card.append(make('p', 'af-error-title', 'The API finder could not load'), make('p', 'af-err', state.error), again, make('p', 'af-sub', FAILED_NOTE));
    return card;
  }

  function emptyBlock(text, actions) {
    const box = make('div', 'af-empty', text);
    if (actions.length) {
      const row = make('div', 'actions');
      row.append(...actions);
      box.append(row);
    }
    return box;
  }

  // The table (wide) and the card list (narrow) share this markup; the container query in the CSS changes the layout.
  function modelsTable(rows) {
    const table = make('table', 'af-table');
    table.append(make('caption', 'sr', 'Models and their lowest prices per million tokens'));
    const head = make('thead');
    const hr = make('tr');
    const cols = [['Model', 'af-c-model'], ['Context', 'af-c-ctx'], ['Input $/M', 'af-c-in'], ['Output $/M', 'af-c-out'], ['Cheapest at', 'af-c-cheap'], ['Sources', 'af-c-src']];
    for (const [text, cls] of cols) {
      const th = make('th', cls, text);
      th.scope = 'col';
      if (text === 'Input $/M') th.title = 'Lowest price per million input tokens across sources';
      if (text === 'Output $/M') th.title = 'Lowest price per million output tokens across sources';
      if (text === 'Cheapest at') th.title = 'Lowest for a typical chat: three input tokens for each output token, before fees';
      hr.append(th);
    }
    const last = make('th', 'af-c-toggle');
    last.scope = 'col';
    last.append(sr('Details'));
    hr.append(last);
    head.append(hr);
    table.append(head);
    const body = make('tbody');
    rows.forEach((row, i) => {
      body.append(modelRow(row, i));
      if (state.expanded === row.key) body.append(detailRow(row, i));
    });
    table.append(body);
    return table;
  }

  function modelRow(row, i) {
    const open = state.expanded === row.key;
    const tr = make('tr', open ? 'af-row open' : 'af-row');
    const model = make('td', 'af-c-model');
    const name = make('button', 'af-name', row.name);
    name.type = 'button';
    name.setAttribute('aria-expanded', String(open));
    name.setAttribute('aria-controls', `af-d-${i}`);
    name.dataset.focus = `name:${row.key}`;
    name.addEventListener('click', () => toggleRow(row.key));
    model.append(name, make('span', 'af-id', row.id));
    if (row.tools === true) model.append(make('span', 'af-tag', 'Tools'));
    if (row.vision === true) model.append(make('span', 'af-tag', 'Vision'));
    if (row.free) model.append(make('span', 'af-tag free', 'Free'));

    const ctx = make('td', 'af-c-ctx');
    ctx.dataset.label = 'Context';
    const ctxText = contextText(row.context);
    ctx.append(make('span', ctxText === '—' ? 'af-none' : '', ctxText));
    if (ctxText === '—') ctx.firstChild.title = 'Not published by these sources';

    tr.append(model, ctx, priceCell(row, 'input'), priceCell(row, 'output'), cheapestCell(row), sourcesCell(row), toggleCell(row, open));
    return tr;
  }

  function priceCell(row, field) {
    const td = make('td', field === 'input' ? 'af-c-in' : 'af-c-out');
    td.dataset.label = field === 'input' ? 'Input $/M' : 'Output $/M';
    const value = row.best ? row.best[field] : null;
    if (value === 0) td.append(make('span', 'af-num free', 'Free'));
    else if (typeof value === 'number') td.append(make('span', 'af-num af-low', priceText(value)));
    else {
      const dash = make('span', 'af-none', '—');
      const unpublished = row.offers.some(o => o.source === 'direct' && o.published === false);
      dash.title = unpublished ? 'Not published; see the provider\'s page' : 'Not listed';
      td.append(dash);
    }
    return td;
  }

  function cheapestCell(row) {
    const td = make('td', 'af-c-cheap');
    td.dataset.label = 'Cheapest at';
    if (!row.best) {
      const dash = make('span', 'af-none', '—');
      dash.title = 'No source lists both prices';
      td.append(dash);
      return td;
    }
    const first = row.best.sources[0];
    const ties = row.best.sources.length;
    const name = make('span', 'af-cheap', ties > 1 ? `${nameOf(first, row)} +${ties - 1}` : nameOf(first, row));
    if (ties > 1) name.title = `Same price at ${listNames(row.best.sources.map(s => nameOf(s, row)))}`;
    td.append(name);
    if (first === 'direct') {
      const from = make('span', 'af-from', `table, ${dateText(state.data.direct.checkedOn)}`);
      from.title = `From Plenum's own table, checked ${dateText(state.data.direct.checkedOn)}, not a live price`;
      td.append(from);
    } else if (sourceStale(first)) {
      const s = sourceById(first);
      const from = make('span', 'af-from', `list from ${timeText(s.at)}`);
      from.title = `From the ${sourceLabel(s)} list read at ${timeText(s.at)}; the last refresh failed`;
      td.append(from);
    }
    return td;
  }

  // A source whose last refresh failed and whose older list is still shown.
  const sourceStale = source => {
    const s = sourceById(source);
    return Boolean(s) && s.ok === false && s.stale === true && Number.isFinite(s.at);
  };

  function sourcesCell(row) {
    const td = make('td', 'af-c-src');
    td.dataset.label = 'Sources';
    td.append(make('span', 'af-num-src', String(row.offers.length)));
    return td;
  }

  function toggleCell(row, open) {
    const td = make('td', 'af-c-toggle');
    const b = MuseUI.button('icon-btn af-toggle', '');
    b.setAttribute('aria-label', `Compare prices for ${row.name}`);
    b.setAttribute('aria-expanded', String(open));
    b.dataset.focus = `toggle:${row.key}`;
    b.append(MuseUI.icon('chevron'));
    b.addEventListener('click', () => toggleRow(row.key));
    td.append(b);
    return td;
  }

  // ---------- painting: the expanded row ----------

  function offerNote(o) {
    const d = state.data;
    const parts = [];
    if (o.source === 'direct') {
      parts.push(o.published === false ? 'Plenum\'s table: price not published' : `Plenum's table, checked ${dateText(d.direct.checkedOn)}`);
      if (o.published !== false && o.note) parts.push(o.note);
    } else {
      if (o.tier?.kind === 'prompt') parts.push(`Higher above ${contextText(o.tier.above)} prompt tokens: ${priceText(o.tier.input)} / ${priceText(o.tier.output)}`);
      else if (o.tier?.kind === 'time') parts.push('Price changes by time of day (UTC). Base price shown.');
      if (sourceStale(o.source)) parts.push(`From the list read at ${timeText(sourceById(o.source).at)}; the last refresh failed.`);
    }
    return parts.join(' · ');
  }

  function offersTable(row) {
    const table = make('table', 'af-offers');
    table.append(make('caption', 'sr', `Prices for ${row.name} at each source`));
    const head = make('thead');
    const hr = make('tr');
    for (const text of ['Source', 'Input', 'Output', 'Context', 'Note']) {
      const th = make('th', '', text);
      th.scope = 'col';
      hr.append(th);
    }
    const link = make('th');
    link.scope = 'col';
    link.append(sr('Link'));
    hr.append(link);
    head.append(hr);
    table.append(head);
    const body = make('tbody');
    for (const o of sortedOffers(row)) {
      const best = Boolean(row.best) && row.best.sources.includes(o.source) && typeof o.input === 'number' && typeof o.output === 'number';
      const tr = make('tr', best ? 'best' : '');
      const srcCell = make('td');
      srcCell.dataset.label = 'Source';
      const nameLine = make('div', 'af-src');
      nameLine.append(make('span', 'af-src-name', nameOf(o.source, row)));
      if (best) nameLine.append(make('span', 'pill ok', row.best.sources.length > 1 ? 'Cheapest (tie)' : 'Cheapest'));
      srcCell.append(nameLine, make('span', 'af-src-kind', SOURCE_KIND[o.source] ?? o.source));
      const inCell = make('td', 'af-num', priceText(o.input));
      inCell.dataset.label = 'Input';
      const outCell = make('td', 'af-num', priceText(o.output));
      outCell.dataset.label = 'Output';
      const ctxCell = make('td', 'af-num', contextText(o.context));
      ctxCell.dataset.label = 'Context';
      const noteCell = make('td', 'af-note', offerNote(o));
      noteCell.dataset.label = 'Note';
      const linkCell = make('td', 'af-link-cell');
      if (isHttps(o.url)) linkCell.append(linkTo(o.url, 'Open', ` the ${nameOf(o.source, row)} page for ${row.name} (opens in your browser)`));
      tr.append(srcCell, inCell, outCell, ctxCell, noteCell, linkCell);
      body.append(tr);
    }
    table.append(body);
    return table;
  }

  // An https link. The visible text is set with textContent, and the arrow is hidden from screen readers.
  function linkTo(url, text, srText = ' (opens in your browser)') {
    const a = make('a', 'af-link', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const arrow = make('span', 'af-ext', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    a.append(arrow, sr(srText));
    a.addEventListener('click', e => {
      if (state.linkTarget === 'plenum' && typeof MuseUI[LINK_HOOK] === 'function') {
        e.preventDefault();
        MuseUI[LINK_HOOK](url);
      }
    });
    return a;
  }

  function feesLine(row) {
    const parts = [];
    const seen = new Set();
    for (const o of sortedOffers(row)) {
      if (o.source === 'direct' || seen.has(o.source)) continue;
      seen.add(o.source);
      const r = routerFor(o.source);
      if (r?.feesShort) parts.push(`${r.name} ${r.feesShort}`);
    }
    return parts.length ? make('p', 'af-fees', `Fees not included: ${parts.join(' · ')}.`) : null;
  }

  function endpointsBlock(row) {
    const id = row.openrouterId;
    const open = state.epOpen.has(id);
    const wrap = make('div', 'af-endpoints-wrap');
    const toggle = MuseUI.button('ghost small af-endpoints-toggle', open ? 'Hide the providers behind OpenRouter' : 'Show the providers behind OpenRouter');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.dataset.focus = `endpoints:${row.key}`;
    toggle.addEventListener('click', () => {
      if (state.epOpen.has(id)) state.epOpen.delete(id);
      else {
        state.epOpen.add(id);
        if (!state.endpoints.has(id)) loadEndpoints(id);
      }
      state.pendingFocus = `endpoints:${row.key}`;
      paintModels();
    });
    wrap.append(toggle);
    if (!open) return wrap;
    wrap.append(make('p', 'af-sub', 'What OpenRouter charges when it sends your request to each provider. OpenRouter chooses among them unless you set provider preferences on its site.'));
    const ep = state.endpoints.get(id);
    if (!ep || ep.state === 'loading') {
      const line = make('div', 'af-loading-inline');
      line.append(make('span', 'spinner'), make('span', 'thinking-text', 'Reading OpenRouter\'s providers for this model…'));
      wrap.append(line);
    } else if (ep.state === 'error') {
      const again = ghost('Try again');
      again.addEventListener('click', () => loadEndpoints(id));
      wrap.append(make('p', 'af-err', ep.message), again);
    } else if (!ep.list.length) {
      wrap.append(make('p', 'af-sub', 'OpenRouter lists no providers for this model right now.'));
    } else {
      wrap.append(endpointsTable(row, ep.list));
    }
    return wrap;
  }

  function endpointsTable(row, list) {
    const scroll = make('div', 'af-scroll');
    const table = make('table', 'af-endpoints');
    table.append(make('caption', 'sr', `Providers behind ${row.name} on OpenRouter`));
    const head = make('thead');
    const hr = make('tr');
    for (const text of ['Provider', 'Input', 'Output', 'Context', 'Quantization', 'Uptime (1 day)']) {
      const th = make('th', '', text);
      th.scope = 'col';
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
    const inputs = list.map(e => e.input).filter(v => typeof v === 'number' && Number.isFinite(v));
    const lowest = inputs.length ? Math.min(...inputs) : null;
    const body = make('tbody');
    for (const e of list) {
      const best = lowest !== null && e.input === lowest;
      const tr = make('tr', best ? 'best' : '');
      tr.append(make('td', '', e.provider || '—'));
      tr.append(make('td', 'af-num', priceText(e.input)));
      tr.append(make('td', 'af-num', priceText(e.output)));
      tr.append(make('td', 'af-num', contextText(e.context)));
      tr.append(make('td', '', e.quantization || '—'));
      tr.append(make('td', 'af-num', typeof e.uptime1d === 'number' ? `${e.uptime1d.toFixed(1)}%` : '—'));
      body.append(tr);
    }
    table.append(body);
    scroll.append(table);
    return scroll;
  }

  function actionsBlock(row) {
    const box = make('div', 'af-actions');
    const d = state.data;
    // The model of the thread on screen, which is the app's model for Main (B-98).
    const current = MuseUI.threads?.info?.()?.model || MuseUI.state.model;
    if (row.openrouterId) {
      const ref = `openrouter:${row.openrouterId}`;
      if (current === ref) box.append(make('span', 'pill ok', 'In use'));
      else {
        const use = primary(state.busy === row.key ? 'Setting…' : 'Use in Plenum', `Sets the model to ${ref}`);
        use.disabled = state.busy === row.key;
        use.dataset.focus = `use:${row.key}`;
        use.addEventListener('click', () => useOpenRouter(row));
        box.append(use);
      }
      const once = ghost('Try once with /ask', `Puts /ask openrouter:${row.openrouterId} in the message box, so only the next message goes to this model`);
      once.addEventListener('click', () => tryOnce(row.openrouterId));
      box.append(once);
      if (needOf('openrouter')) box.append(need('Needs an OpenRouter key.'), openAccountsButton('openrouter'));
      if (d && d.openrouterTools === false) box.append(make('p', 'af-sub af-wide', 'Through OpenRouter, Plenum runs this model without project tools (text only).'));
    }
    if (row.plenumRef) {
      const ref = row.plenumRef;
      const name = MuseUI.modelName(ref);
      if (current === ref) box.append(make('span', 'pill ok', `${name} in use`));
      else {
        const b = ghost(`Use ${name} direct`, `Sets the model to ${ref}`);
        b.disabled = state.busy === row.key;
        b.dataset.focus = `use:${row.key}`;
        b.addEventListener('click', () => useDirect(row));
        box.append(b);
      }
      const provider = providerOf(ref);
      const why = needOf(provider);
      if (why) box.append(need(`${why}.`), openAccountsButton(provider));
    }
    if (!row.openrouterId && !row.plenumRef) {
      box.append(make('p', 'af-nouse af-wide', 'Plenum cannot call this model yet: none of the sources listing it is a provider Plenum connects to. Use the links above to sign up with a router.'));
    }
    return box;
  }

  function detailRow(row, i) {
    const tr = make('tr', 'af-detail');
    const cell = make('td');
    cell.colSpan = 7;
    const box = make('div', 'af-detail');
    box.id = `af-d-${i}`;
    box.append(make('p', 'af-detail-title', `${row.name} · prices per million tokens`));
    box.append(offersTable(row));
    const fees = feesLine(row);
    if (fees) box.append(fees);
    if (row.openrouterId) box.append(endpointsBlock(row));
    box.append(actionsBlock(row));
    cell.append(box);
    tr.append(cell);
    return tr;
  }

  // ---------- painting: lists and the Models tab ----------

  function paintModels() {
    const r = state.refs;
    if (!r) return;
    paintFilterBar();
    const d = state.data;
    r.list.replaceChildren();
    r.more.hidden = true;
    if (!d) {
      r.list.append(state.error ? errorCard() : loadingBlock());
      r.count.textContent = '';
      state.hits = 0;
      return;
    }
    if (!d.models.length) {
      const retry = primary('Try again', 'Read the price lists again');
      retry.addEventListener('click', () => load(true));
      const routersBtn = ghost('Show routers');
      routersBtn.addEventListener('click', () => setTab('routers'));
      r.list.append(emptyBlock('No prices could be read. Check the internet connection, then press Refresh.', [retry, routersBtn]));
      r.count.textContent = '';
      state.hits = 0;
      return;
    }
    const hits = sortRows(filterRows(d.models, state.query, state.filters), state.sort);
    state.hits = hits.length;
    if (!hits.length) {
      const onlySearch = state.query !== '' && filterCount() === 0;
      const box = onlySearch
        ? emptyBlock(`No model matches “${state.query}”.`, [clearSearchButton()])
        : emptyBlock('No model matches these filters.', [clearFiltersButton()]);
      r.list.append(box);
      r.count.textContent = '0 models';
    } else {
      const shown = hits.slice(0, state.shown);
      r.list.append(modelsTable(shown));
      const n = hits.length;
      r.count.textContent = n > shown.length
        ? `Showing ${shown.length} of ${n} models. Search or filter to narrow the list.`
        : `${n} ${n === 1 ? 'model' : 'models'}`;
      if (n > shown.length) {
        r.more.hidden = false;
        r.more.textContent = `Show ${Math.min(PAGE, n - shown.length)} more`;
      }
    }
    if (state.scrollToExpanded) {
      state.scrollToExpanded = false;
      r.list.querySelector('tr.af-row.open')?.scrollIntoView({ block: 'nearest' });
    }
    restoreFocus();
  }

  function clearSearchButton() {
    const b = MuseUI.button('ghost small', 'Clear search');
    b.addEventListener('click', () => {
      state.query = '';
      resetView();
      paintModels();
      state.refs?.search.focus();
    });
    return b;
  }

  function clearFiltersButton() {
    const b = MuseUI.button('ghost small', 'Clear filters');
    b.addEventListener('click', clearAll);
    return b;
  }

  function clearAll() {
    state.query = '';
    state.filters = { ...FILTER_DEFAULT };
    resetView();
    paintModels();
    state.refs?.search.focus();
  }

  // After a repaint, focus returns to the control that asked for it (the row's name, a toggle, or a link to the endpoints).
  function restoreFocus() {
    const token = state.pendingFocus;
    if (!token) return;
    state.pendingFocus = '';
    const node = [...(state.refs?.list.querySelectorAll('[data-focus]') ?? [])].find(n => n.dataset.focus === token);
    node?.focus({ preventScroll: true });
  }

  // The routers tab and the models tab both come from the same read, so one call paints both lists.
  function paintLists() {
    paintModels();
    paintRouters();
    paintTabs();
  }

  // ---------- painting: routers ----------

  function routerCard(r) {
    const src = r.feed ? sourceById(r.feed) : null;
    const mark = String(r.name).charAt(0);
    const kind = KIND_LABEL[r.kind] ?? r.kind;
    const card = MuseUI.cardShell(mark, 'af', r.name, kind, 'Checked', false);
    const pill = card.querySelector('.pill');
    if (r.feed) {
      if (!state.data) {
        pill.textContent = 'Not read yet';
        pill.className = 'pill';
      } else if (src?.ok) {
        pill.textContent = `Live · ${src.count} models`;
        pill.className = 'pill ok';
        pill.title = `Read at ${timeText(src.at)}`;
      } else if (src?.stale && Number.isFinite(src.at)) {
        pill.textContent = `From ${timeText(src.at)}`;
        pill.className = 'pill warn';
        pill.title = src.message || '';
      } else {
        pill.textContent = 'Not read';
        pill.className = 'pill bad';
        pill.title = src?.message || 'Not read yet';
      }
    } else {
      pill.textContent = `Checked ${dateText(state.data?.directory?.checkedOn ?? '2026-10-20')}`;
      pill.className = 'pill';
    }

    const facts = make('dl', 'af-facts');
    const fact = (label, node) => {
      const dt = make('dt', '', label);
      const dd = make('dd');
      if (node) dd.append(node);
      facts.append(dt, dd);
    };
    if (r.fees) {
      const fees = make('span', '', r.fees);
      const feesLink = r.feesUrl ? linkTo(r.feesUrl, 'Source') : null;
      if (feesLink) fees.append(' ', feesLink);
      fact('Fees', fees);
    }
    let prices = r.prices || '';
    if (r.feed) {
      if (src?.ok) prices = `Live list, ${src.count} models`;
      else if (src?.stale && Number.isFinite(src.at)) prices = `List from ${timeText(src.at)}`;
      else prices = 'Not read';
    }
    fact('Prices', make('span', '', prices));
    const baseWrap = make('span');
    if (r.baseUrl) {
      baseWrap.append(make('code', 'af-code', r.baseUrl));
      const copy = ghost('Copy', '');
      copy.setAttribute('aria-label', `Copy the ${r.name} base URL`);
      copy.addEventListener('click', async () => {
        await MuseUI.copyText(r.baseUrl);
        MuseUI.toast('Base URL copied.');
      });
      baseWrap.append(' ', copy);
      if (r.baseUrlNote) baseWrap.append(' ', make('span', 'af-muted', `(${r.baseUrlNote})`));
    } else {
      baseWrap.append(make('span', 'af-muted', 'Not confirmed'));
      if (r.baseUrlNote) baseWrap.append(' ', make('span', 'af-muted', `(${r.baseUrlNote})`));
    }
    fact('Base URL', baseWrap);
    fact('In Plenum', inPlenumFor(r.plenum));

    const links = make('div', 'af-links');
    const pushLink = (url, label) => {
      const a = linkTo(url, label);
      if (a) links.append(a);
    };
    pushLink(r.site, 'Website');
    pushLink(r.pricingUrl, 'Pricing');
    pushLink(r.docsUrl, 'Docs');
    pushLink(r.signupUrl, r.plenum === 'openrouter' ? 'Get a key' : 'Sign up');
    card.classList.add('af-router');
    const body = make('div', 'card-body');
    body.append(facts, links);
    card.append(body);
    return card;
  }

  // What the router means for Plenum: OpenRouter's key, or a line saying it is not connected.
  function inPlenumFor(plenum) {
    const frag = document.createDocumentFragment();
    if (plenum === 'openrouter') {
      frag.append(document.createTextNode('Every model, as openrouter:<id>. Text only, without project tools. '));
      if (readyOf('openrouter')) frag.append(make('span', 'pill ok', 'Key saved'));
      else {
        frag.append(need('No key yet'), ' ', openAccountsButton('openrouter'));
      }
    } else {
      frag.append(make('span', 'af-muted', 'Not connected to Plenum.'));
    }
    return frag;
  }

  function directCard(p) {
    const card = MuseUI.cardShell(String(p.name).charAt(0), 'af', p.name, KIND_LABEL.direct, `Checked ${dateText(state.data.direct.checkedOn)}`, false);
    const facts = make('dl', 'af-facts');
    facts.append(make('dt', '', 'Prices'), make('dd', '', `Plenum's table, checked ${dateText(state.data.direct.checkedOn)}`));
    const dd = make('dd');
    const ok = readyOf(p.plenum);
    const why = needOf(p.plenum);
    if (ok) dd.append(make('span', 'pill ok', 'Ready'));
    else dd.append(need(`${why || 'Not ready'}.`), ' ', openAccountsButton(p.plenum));
    facts.append(make('dt', '', 'In Plenum'), dd);
    const links = make('div', 'af-links');
    for (const [url, label] of [[p.keyUrl, 'Get a key'], [p.docsUrl, 'Docs'], [p.pricingUrl, 'Pricing']]) {
      const a = linkTo(url, label);
      if (a) links.append(a);
    }
    card.classList.add('af-router');
    const body = make('div', 'card-body');
    body.append(facts, links);
    card.append(body);
    return card;
  }

  function group(title, sub, cards) {
    const wrap = make('div', 'af-group-wrap');
    wrap.append(make('h3', 'kicker af-group', title));
    if (sub) wrap.append(make('p', 'af-sub', sub));
    const grid = make('div', 'af-cards');
    grid.append(...cards);
    wrap.append(grid);
    return wrap;
  }

  function paintRouters() {
    const r = state.refs;
    if (!r) return;
    r.routers.replaceChildren();
    const d = state.data;
    if (!d) {
      r.routers.append(state.error ? errorCard() : loadingRouters());
      return;
    }
    const routers = d.directory.routers;
    const live = routers.filter(x => x.feed);
    const byHand = routers.filter(x => !x.feed);
    const handDate = dateText(d.directory.checkedOn);
    const directDate = dateText(d.direct.checkedOn);
    r.routers.append(make('p', 'af-caveat', `Where you can buy access to models. Four routers publish a price list Plenum reads live; the others were checked by hand on ${handDate}.`));
    r.routers.append(group(`Live price lists (${live.length})`, '', live.map(routerCard)));
    r.routers.append(group(`Checked by hand · ${handDate} (${byHand.length})`, `These publish no price list Plenum can read, so this table was typed in from their pages on ${handDate} and may be out of date.`, byHand.map(routerCard)));
    const providers = d.direct.providers;
    r.routers.append(group(`Direct providers Plenum supports (${providers.length})`, `Prices come from Plenum's own table, checked ${directDate}.`, providers.map(directCard)));
  }

  function loadingRouters() {
    const wrap = make('div', 'af-loading-wrap');
    const line = make('div', 'af-loading');
    line.append(make('span', 'spinner'), make('span', 'thinking-text', 'Reading the router list…'));
    wrap.append(line);
    return wrap;
  }

  function paintAll() {
    paintFresh();
    paintTabs();
    paintModels();
    paintRouters();
  }

  // ---------- tabs, the section and the Accounts entry ----------

  function setTab(key) {
    state.tab = key;
    paintTabs();
    const node = key === 'models' ? state.refs?.tabModels : state.refs?.tabRouters;
    node?.focus();
  }

  function tabButton(key, label) {
    const b = make('button', 'seg-btn', label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.id = `af-tab-${key}`;
    b.setAttribute('aria-controls', `af-pane-${key}`);
    b.addEventListener('click', () => setTab(key));
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      setTab(key === 'models' ? 'routers' : 'models');
    });
    return b;
  }

  // The static part of the section: built once for each time the section is drawn, and painted from memory.
  function buildPanel() {
    const refs = { chips: new Map() };
    const root = make('div', 'af-panel');
    refs.root = root;

    // A. Freshness strip
    const fresh = make('div', 'af-fresh');
    fresh.setAttribute('role', 'group');
    fresh.setAttribute('aria-label', 'Price freshness');
    refs.headline = make('span', 'af-headline');
    refs.age = make('span', 'af-age');
    refs.pills = make('div', 'af-pills');
    refs.refresh = ghost('Refresh');
    refs.refresh.classList.add('af-refresh');
    refs.refresh.addEventListener('click', () => load(true));
    refs.note = make('p', 'af-fresh-note');
    refs.note.setAttribute('role', 'status');
    const head = make('div', 'af-fresh-head');
    head.append(refs.headline, refs.age);
    fresh.append(head, refs.refresh, refs.pills, refs.note);
    refs.warn = make('p', 'af-warn');
    refs.warn.setAttribute('role', 'status');
    refs.warn.hidden = true;

    // B. Caveat. The LEGAL strip is drawn above it by MuseUI.notice; until that is in place, this line is the caveat.
    refs.caveat = make('p', 'af-caveat', CAVEAT);

    // C. Tabs
    const tabs = make('div', 'seg af-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'What to show');
    refs.tabModels = tabButton('models', 'Models');
    refs.tabRouters = tabButton('routers', 'Routers');
    tabs.append(refs.tabModels, refs.tabRouters);

    // D. Models tab
    refs.modelsPane = make('div', 'af-pane af-models');
    refs.modelsPane.setAttribute('role', 'tabpanel');
    refs.modelsPane.id = 'af-pane-models';
    refs.modelsPane.setAttribute('aria-labelledby', 'af-tab-models');
    const bar = make('div', 'af-filters-bar');
    refs.search = make('input', 'af-search');
    refs.search.type = 'search';
    refs.search.placeholder = 'Search by model, provider or id';
    refs.search.setAttribute('aria-label', 'Search models');
    refs.search.maxLength = 100;
    refs.search.autocomplete = 'off';
    refs.search.spellcheck = false;
    refs.search.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.query = (state.refs?.search.value ?? '').trim();
        resetView();
        paintModels();
      }, SEARCH_MS);
    });
    refs.filterToggle = ghost('Filters');
    refs.filterToggle.classList.add('af-filter-toggle');
    refs.filterToggle.setAttribute('aria-controls', 'af-filter-body');
    refs.filterToggle.addEventListener('click', () => {
      state.filtersOpen = !state.filtersOpen;
      paintFilterBar();
    });
    refs.sort = select('af-select af-sort', 'Sort', SORT_OPTIONS, value => {
      state.sort = value;
      resetView();
      paintModels();
    });
    refs.provider = make('select', 'af-select af-provider');
    refs.provider.setAttribute('aria-label', 'Model provider');
    refs.provider.addEventListener('change', () => {
      state.filters.vendor = refs.provider.value;
      resetView();
      paintModels();
    });
    refs.price = select('af-select af-price', 'Highest input price per million tokens', PRICE_OPTIONS, value => {
      state.filters.price = value;
      resetView();
      paintModels();
    });
    refs.context = select('af-select af-context', 'Smallest context window', CONTEXT_OPTIONS.map(([v, t]) => [String(v), t]), value => {
      state.filters.context = Number(value);
      resetView();
      paintModels();
    });
    refs.filterBody = make('div', 'af-filter-body');
    refs.filterBody.id = 'af-filter-body';
    const chipRow = make('div', 'af-chips-row');
    for (const [key, label, title] of [
      ['tools', 'Tools', 'Takes tool calls at the router. Through OpenRouter, Plenum runs models without project tools.'],
      ['vision', 'Vision', 'Reads images'],
      ['usable', 'Works in Plenum', 'Models Plenum can call: through OpenRouter, or directly with a provider it supports.'],
    ]) {
      const chip = make('button', 'af-chip', label);
      chip.type = 'button';
      chip.title = title;
      chip.addEventListener('click', () => {
        state.filters[key] = !state.filters[key];
        resetView();
        paintModels();
      });
      refs.chips.set(key, chip);
      chipRow.append(chip);
    }
    refs.clear = make('button', 'af-clear', 'Clear filters');
    refs.clear.type = 'button';
    refs.clear.addEventListener('click', clearAll);
    chipRow.append(refs.clear);
    refs.filterBody.append(refs.provider, refs.price, refs.context, chipRow);
    refs.count = make('p', 'af-count');
    refs.count.setAttribute('role', 'status');
    bar.append(refs.search, refs.filterToggle, refs.sort, refs.filterBody, refs.count);
    // The search and the filter toggle come first on a narrow panel; the order is set in the CSS for the wide layout.
    refs.list = make('div', 'af-list');
    refs.more = ghost('Show 50 more');
    refs.more.classList.add('af-more');
    refs.more.addEventListener('click', () => {
      state.shown += PAGE;
      paintModels();
    });
    refs.modelsPane.append(bar, refs.list, refs.more);

    // Routers tab
    refs.routersPane = make('div', 'af-pane af-routers');
    refs.routersPane.setAttribute('role', 'tabpanel');
    refs.routersPane.id = 'af-pane-routers';
    refs.routersPane.setAttribute('aria-labelledby', 'af-tab-routers');
    refs.routers = make('div', 'af-routers-body');
    refs.routersPane.append(refs.routers);

    // F. Footer
    const foot = make('div', 'af-foot-wrap');
    foot.append(make('p', 'af-foot', FOOTER));
    if (typeof MuseUI[LINK_HOOK] === 'function') {
      const row = make('div', 'af-open-in');
      row.append(make('span', 'af-open-in-label', 'Open links in'));
      const seg = make('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Where links open');
      for (const [value, label] of [['system', 'Your browser'], ['plenum', 'Plenum']]) {
        const b = make('button', 'seg-btn', label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(state.linkTarget === value));
        b.addEventListener('click', () => {
          state.linkTarget = value;
          for (const node of seg.children) node.setAttribute('aria-pressed', String(node === b));
        });
        seg.append(b);
      }
      row.append(seg);
      foot.append(row);
    }

    root.append(fresh, refs.warn, refs.caveat, tabs, refs.modelsPane, refs.routersPane, foot);
    return refs;
  }

  function select(cls, label, options, onChange) {
    const s = make('select', cls);
    s.setAttribute('aria-label', label);
    for (const [value, text] of options) s.append(new Option(text, value));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function startClock(root) {
    clearInterval(state.clock);
    state.clock = setInterval(() => {
      if (!root.isConnected) {
        clearInterval(state.clock);
        return;
      }
      paintAge();
    }, CLOCK_MS);
  }

  // Remembers the scroll position of the drawer body while this section is on screen.
  function bindScroll() {
    if (state.scrollBound) return;
    state.scrollBound = true;
    MuseUI.el.drawerBody.addEventListener('scroll', () => {
      if (state.refs?.root.isConnected) state.scrollTop = MuseUI.el.drawerBody.scrollTop;
    }, { passive: true });
  }

  // Runs the read once this section is actually on screen (IntersectionObserver), so opening Settings alone reads nothing.
  function whenShown(node, fn) {
    if (typeof IntersectionObserver !== 'function') {
      fn();
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      observer.disconnect();
      fn();
    });
    observer.observe(node);
  }

  // Draws the section into the Settings drawer. Called on each open; the state is kept in memory.
  function draw(body) {
    const refs = buildPanel();
    state.refs = refs;
    body.append(refs.root);
    bindScroll();
    paintAll();
    if (state.data && state.scrollTop) {
      requestAnimationFrame(() => {
        MuseUI.el.drawerBody.scrollTop = state.scrollTop;
      });
    }
    startClock(refs.root);
    if (typeof MuseUI.notice === 'function') MuseUI.notice(NOTICE_ID, { before: refs.caveat });
    if (state.focusSearch) {
      state.focusSearch = false;
      requestAnimationFrame(() => refs.search.focus({ preventScroll: true }));
    }
    whenShown(refs.root, () => {
      if (!refs.root.isConnected) return;
      loadReadiness();
      load(false);
    });
  }

  // The Settings section. Its position follows the Accounts section (UI-ARCH section 5).
  if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
    MuseUI.settings.register({ id: SECTION_ID, scope: 'app', title: TITLE, order: ORDER, render: draw });
  }

  // Opens the API finder in Settings, scrolled to its section. The Accounts link and the model banner call this.
  MuseUI.openApiFinder = () => {
    state.focusSearch = true;
    MuseUI.settings.open('app');
    requestAnimationFrame(() => {
      document.querySelector(`[data-section="${SECTION_ID}"]`)?.scrollIntoView({ block: 'start' });
    });
  };

  // ---------- the link from Accounts ----------

  // The quiet row at the end of the API keys section in Settings > Accounts. The keys section (ext-accounts-api) draws it into
  // itself by calling MuseUI.apiFinderEntry() each time Settings opens, so nothing here watches a drawer for it.
  function accountsEntry() {
    const p = make('p', 'af-accounts-entry');
    p.append(make('span', '', 'Looking for a cheaper route to a model? '));
    const b = ghost('Compare prices in API finder');
    b.addEventListener('click', () => MuseUI.openApiFinder());
    p.append(b);
    return p;
  }

  MuseUI.apiFinderEntry = accountsEntry;

  MuseUI.apiFinder = MODULE_EXPORTS;
})();
