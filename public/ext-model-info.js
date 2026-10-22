// ext-model-info. Loaded by ext.js and adds itself through window.MuseUI. Each model in the model menu and the Advisor menu
// gets a second line: what it costs, how much context it takes and whether it can use the project tools. A model whose provider
// cannot answer yet says why first. A banner above the composer names the chosen model when its provider is not ready, with an
// Open Accounts button. The data comes from GET /api/models/info. This file never changes an option's value, never removes an
// option and never disables Send: a model that is not ready can still be chosen and sent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const INFO_URL = '/api/models/info';
  const EVERY_MS = 60_000;
  const TIMEOUT_MS = 8000;
  const TOOL_WORDS = { yes: 'tools', cli: 'own tools', no: 'text only' };

  // What the server last sent. A failed read keeps the copy that is already here.
  let models = {};
  let readiness = {};

  // "$2" and "$10" stay whole, and any other price keeps two decimals: "$0.10/$0.50", "$1.32/$3.96".
  const money = n => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  // 1000000 -> "1M", 500000 -> "500K".
  const windowText = tokens => (tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`);

  // "anthropic:claude-sonnet-5-5" -> "anthropic". A value with no provider (the Advisor's "off") gives ''.
  function providerOf(ref) {
    const i = ref.indexOf(':');
    return i < 0 ? '' : ref.slice(0, i);
  }

  const stateOf = ref => {
    const p = providerOf(ref);
    return p && Object.hasOwn(readiness, p) ? readiness[p] : null;
  };

  const infoOf = ref => (Object.hasOwn(models, ref) ? models[ref] : null);

  // The variable that holds each provider's key under plain Node (lib/api-providers.mjs, and README). The desktop app keeps
  // keys in Accounts instead, and Accounts cannot save them under plain Node. NEEDS_KEY is the readiness text for a key.
  const ENV_KEY = {
    anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
    mistral: 'MISTRAL_API_KEY', googleai: 'GOOGLE_AI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  };
  const NEEDS_KEY = 'Needs an API key';

  // One model's facts as a line: "$2/$10 per M · 1M context · tools".
  function lineFor(info) {
    const price = info.price ? `$${money(info.price.input)}/$${money(info.price.output)} per M` : 'price not published';
    const context = info.context ? `${windowText(info.context)} context` : 'context not published';
    return [price, context, TOOL_WORDS[info.tools] ?? 'text only'].join(' · ');
  }

  // What a menu choice says after its name: why its provider cannot answer, then its facts. '' when there is nothing to say.
  function partsFor(ref) {
    const state = stateOf(ref);
    const parts = [];
    if (state && !state.ready) parts.push(state.why);
    const info = infoOf(ref);
    if (info) parts.push(lineFor(info));
    return parts.join(' · ');
  }

  // A rich menu (where the browser can style one) shows a choice's name and an optional note on two lines. The note is
  // kept as it was, and the facts follow it. A choice with no note gets one.
  function decorateRich(option, text, parts) {
    if (text.dataset.note === undefined) text.dataset.note = text.querySelector('.o-note')?.textContent ?? '';
    const note = [text.dataset.note, parts].filter(Boolean).join(' · ');
    let el = text.querySelector('.o-note');
    if (!note) {
      el?.remove();
      return;
    }
    if (!el) {
      el = MuseUI.span('o-note', '');
      text.append(el);
    }
    el.textContent = note;
  }

  // A plain menu shows the whole choice as text, so the facts go after a dash. The text it had is remembered in dataset.base.
  function decoratePlain(option, parts) {
    if (option.dataset.base === undefined) option.dataset.base = option.text;
    option.text = parts ? `${option.dataset.base} — ${parts}` : option.dataset.base;
  }

  // Adds the facts to every model choice in one menu. A choice whose value has no provider ("off") is left as it is.
  function decorate(select) {
    for (const option of select.querySelectorAll('option')) {
      if (!option.value.includes(':')) continue;
      const parts = partsFor(option.value);
      const text = option.querySelector('.o-text');
      if (text) decorateRich(option, text, parts);
      else decoratePlain(option, parts);
    }
  }

  // Whether a menu's popup is open. A menu whose popup cannot be asked returns false, so it is decorated at once as before.
  function pickerOpen(select) {
    try {
      return select.matches(':open');
    } catch {
      return false;
    }
  }

  // Rows that grow while a popup is open move under the pointer, so a click can commit the wrong model. While either menu is
  // open the rows are left alone, and they are decorated when both are closed. The menus are checked again every 150 ms.
  let waitTimer = null;
  function decorateWhenClosed() {
    if (pickerOpen(MuseUI.el.model) || pickerOpen(MuseUI.el.advisor)) {
      clearTimeout(waitTimer);
      waitTimer = setTimeout(decorateWhenClosed, 150);
      return;
    }
    waitTimer = null;
    decorateAll();
  }

  // The banner above the composer. It is shown only while the chosen model's provider cannot answer.
  const banner = document.createElement('div');
  banner.className = 'ext-model-banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  const bannerText = MuseUI.span('emb-text', '');
  const openBtn = MuseUI.button('ghost small emb-open', 'Open Accounts');
  openBtn.addEventListener('click', () => MuseUI.el.accountsBtn.click());
  banner.append(bannerText, openBtn);
  MuseUI.el.form.before(banner);

  function paint() {
    const ref = MuseUI.el.model.value;
    const state = stateOf(ref);
    const blocked = Boolean(state) && !state.ready;
    banner.hidden = !blocked;
    if (!blocked) return;
    // Under plain Node the key comes from an environment variable and Accounts cannot save it, so the banner names the variable.
    const env = ENV_KEY[providerOf(ref)];
    if (state.why === NEEDS_KEY && env && document.documentElement.dataset.shell !== 'desktop') {
      bannerText.textContent = `Set ${env} before starting Plenum, so ${MuseUI.modelName(ref)} cannot answer yet.`;
      return;
    }
    // Only the first letter is lowered, so "API" keeps its capitals.
    const why = state.why.charAt(0).toLowerCase() + state.why.slice(1);
    bannerText.textContent = `${state.label} ${why}, so ${MuseUI.modelName(ref)} cannot answer yet.`;
  }

  function decorateAll() {
    decorate(MuseUI.el.model);
    decorate(MuseUI.el.advisor);
  }

  // Reads the facts and the readiness. A failed read changes nothing, so the last good copy stays on screen.
  async function load() {
    try {
      const res = await MuseUI.request(INFO_URL, {
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.models === 'object' && data.models) models = data.models;
        if (data && typeof data.readiness === 'object' && data.readiness) readiness = data.readiness;
      }
    } catch {
      // Keep the copy that is already here.
    }
    decorateWhenClosed();
    paint();
  }

  // A menu can be filled again (the page builds its choices when the catalog arrives), so each one is decorated as it changes.
  // While a popup is open that waits until it closes (decorateWhenClosed).
  for (const select of [MuseUI.el.model, MuseUI.el.advisor]) {
    new MutationObserver(() => {
      decorateWhenClosed();
      paint();
    }).observe(select, { childList: true });
  }
  MuseUI.el.model.addEventListener('change', paint);
  // The page redraws its top bar whenever it reads the state again, and that can change the chosen model.
  new MutationObserver(paint).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });
  // Closing the Accounts drawer is when a key may have been saved, so the readiness is read again then.
  new MutationObserver(() => {
    if (MuseUI.el.drawer.hidden) load();
  }).observe(MuseUI.el.drawer, { attributes: true, attributeFilter: ['hidden'] });

  decorateAll();
  paint();
  load();
  setInterval(load, EVERY_MS);
})();
