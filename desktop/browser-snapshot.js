// The two scripts the Plenum browser runs inside a page for a model (brw-03): `snapshot` reads the page and gives every control a ref,
// `act` does one small thing to a ref. This file is TEXT, not a module: desktop/browser.cjs reads it once when it loads and wraps it as
//   (<this file>).snapshot(JSON.parse(<a JSON string>))        or        (<this file>).act(JSON.parse(<a JSON string>))
// then runs it in an ISOLATED world of the page (webContents.executeJavaScriptInIsolatedWorld), so the page's own scripts cannot replace
// the functions used here and cannot see the script. The file is never built from page or model text. What reaches it is data only:
// numbers for the limits, a ref that matches /^e\d{1,4}$/, and (for set-value, select and expect) strings that are read as data and never
// run. The page's text, names and values come back as plain strings that the caller cuts and checks again.
//
//   snapshot({ maxElements, maxChars }) -> { url, title, text, elements: [{ ref, role, name, value?, type?, checked?, disabled?, href?,
//     x, y, w, h, inForm, submit, post?, secret?, near? }], password, captcha, truncated, scroll }
//   act({ action, ref?, expect?, ... }) -> { ok: true, ... } or { ok: false, message }
//     actions: prepare-click, focus, read-value, set-value, select, scroll, focus-info, dom-click, submit-form, arm-input, check-input
//     (arm-input starts listening for a real mouse or key event; check-input says whether one came, and stops listening: the desktop
//     uses them to send input again that never reached the page)
//     (focus and guard-on answer { secret, moved, at? }: moved is true when the page's own scripts put the focus on another element than
//     the ref, secret when that element or the ref is a password, code or card field. guard-on also starts a listener that blurs a
//     field that takes the focus and cancels an insert aimed anywhere but the ref; guard-off stops it and says what it saw)
//
// A password field is listed with type 'password' and no value. So is any field that looks like a one-time code, a security code or a
// card number (`secret`): its value is never read. Hidden inputs, file inputs and anything not drawn on the page are left out.
(() => {
  'use strict';
  const REF_ATTR = 'data-plenum-ref';
  const REF_RE = /^e\d{1,4}$/;
  const NAME_MAX = 80;
  const VALUE_MAX = 60;
  const HREF_MAX = 80;
  const NEAR_MAX = 160;
  const CAPTCHA_RE = /captcha|verify you are human|i'm not a robot|unusual traffic/i;
  const SECRET_NAME_RE = /otp|one[- ]?time|2fa|cvv|cvc|security code|verification code|card number|passcode|passw/i;
  const SECRET_AUTOCOMPLETE_RE = /one-time-code|cc-csc|cc-number|current-password|new-password/i;
  const SELECTOR = 'a[href], button, input, select, textarea, summary, [role], [contenteditable], [onclick], [tabindex]';
  const ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'combobox', 'textbox',
    'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox',
  ]);

  const clean = (value, max) => {
    const text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };
  const lower = value => String(value || '').toLowerCase();

  // ---------- what an element is ----------

  const inputType = el => lower(el.getAttribute('type') || el.type || 'text');

  const roleOf = el => {
    const explicit = lower(el.getAttribute('role')).split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = lower(el.tagName);
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'clickable';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = inputType(el);
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };

  const labelText = el => {
    if (!el.labels || !el.labels.length) return '';
    return Array.prototype.map.call(el.labels, l => l.textContent).join(' ');
  };

  const nameOf = el => {
    let n = el.getAttribute('aria-label');
    if (!n) {
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        n = ids.split(/\s+/).map(id => {
          const target = document.getElementById(id);
          return target ? target.textContent : '';
        }).join(' ');
      }
    }
    const tag = lower(el.tagName);
    if (!clean(n, NAME_MAX) && (tag === 'input' || tag === 'select' || tag === 'textarea')) n = labelText(el);
    if (!clean(n, NAME_MAX) && tag === 'input') {
      const t = inputType(el);
      if (t === 'button' || t === 'submit' || t === 'reset') n = el.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
      else if (t === 'image') n = el.getAttribute('alt') || el.getAttribute('title');
    }
    if (!clean(n, NAME_MAX)) n = el.getAttribute('placeholder') || el.getAttribute('title');
    if (!clean(n, NAME_MAX) && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      n = el.innerText || el.textContent;
      if (!clean(n, NAME_MAX)) {
        const img = el.querySelector('img[alt], svg title');
        n = img ? (img.getAttribute && img.getAttribute('alt')) || img.textContent : '';
      }
    }
    if (!clean(n, NAME_MAX)) n = el.getAttribute('name') || el.id || '';
    return clean(n, NAME_MAX);
  };

  const isSecret = el => {
    const tag = lower(el.tagName);
    if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return false;
    if (inputType(el) === 'password') return true;
    if (SECRET_AUTOCOMPLETE_RE.test(el.getAttribute('autocomplete') || '')) return true;
    const probe = [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
    return SECRET_NAME_RE.test(probe);
  };

  const isVisible = el => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  };

  const formOf = el => el.form || (el.closest ? el.closest('form') : null);

  const isSubmit = el => {
    const tag = lower(el.tagName);
    if (tag === 'input') {
      const t = inputType(el);
      return (t === 'submit' || t === 'image') && !!formOf(el);
    }
    if (tag === 'button') return lower(el.type || 'submit') === 'submit' && !!formOf(el);
    return false;
  };

  const sensitiveForm = form => {
    if (!form) return false;
    const fields = form.querySelectorAll('input');
    for (const f of fields) {
      const t = inputType(f);
      if (t === 'password' || t === 'email' || t === 'tel') return true;
      if (/^cc-|street-address|postal-code/i.test(f.getAttribute('autocomplete') || '')) return true;
    }
    return false;
  };

  // The facts about a form control that the cards and the checks need, without its value.
  const describeForm = el => {
    const form = formOf(el);
    if (!form) return {};
    const out = { inForm: true };
    if (lower(form.getAttribute('method') || 'get') === 'post') out.post = true;
    if (sensitiveForm(form)) out.sensitive = true;
    if (isSubmit(el)) out.near = clean(form.innerText || form.textContent, NEAR_MAX);
    return out;
  };

  const hrefOf = el => {
    if (lower(el.tagName) !== 'a' || !el.hasAttribute('href')) return '';
    try {
      const url = new URL(el.href, location.href);
      return clean(url.host + url.pathname, HREF_MAX);
    } catch (e) {
      return '';
    }
  };

  const mismatch = (el, expect) => {
    if (!expect || typeof expect !== 'object') return null;
    const role = roleOf(el);
    const name = nameOf(el);
    const want = lower(clean(expect.name, NAME_MAX)).slice(0, 40);
    if (typeof expect.name === 'string' && want !== lower(name).slice(0, 40)) {
      return { ok: false, message: 'The page changed since the snapshot (that control is now labelled differently). Take a new snapshot.' };
    }
    if (typeof expect.role === 'string' && expect.role && lower(expect.role) !== role) {
      return { ok: false, message: 'The page changed since the snapshot (that control is now a different kind). Take a new snapshot.' };
    }
    return null;
  };

  const find = ref => {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return null;
    return document.querySelector('[' + REF_ATTR + '="' + ref + '"]');
  };

  const gone = ref => ({ ok: false, message: 'There is no control ' + clean(ref, 8) + ' on the page now. Take a new snapshot.' });

  const editable = el => {
    const tag = lower(el.tagName);
    if (tag === 'textarea') return !el.readOnly && !el.disabled;
    if (tag === 'input') {
      const t = inputType(el);
      if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].indexOf(t) >= 0) return false;
      return !el.readOnly && !el.disabled;
    }
    return !!el.isContentEditable;
  };

  // ---------- snapshot ----------

  const snapshot = args => {
    const maxElements = Math.max(1, Math.min(2000, Math.floor(Number(args && args.maxElements)) || 600));
    const maxChars = Math.max(1000, Math.min(60000, Math.floor(Number(args && args.maxChars)) || 12000));
    for (const old of document.querySelectorAll('[' + REF_ATTR + ']')) old.removeAttribute(REF_ATTR);

    const elements = [];
    let truncated = false;
    let passwordVisible = false;
    const take = (el, role) => {
      const n = elements.length + 1;
      el.setAttribute(REF_ATTR, 'e' + n);
      const rect = el.getBoundingClientRect();
      const type = lower(el.tagName) === 'input' ? inputType(el) : '';
      const item = { ref: 'e' + n, role, name: nameOf(el) };
      if (type) item.type = type;
      const secret = isSecret(el);
      if (secret) item.secret = true;
      const tag = lower(el.tagName);
      if (!secret && (tag === 'input' || tag === 'textarea') && type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'image' && el.value) {
        item.value = clean(el.value, VALUE_MAX);
      } else if (tag === 'select' && el.selectedOptions && el.selectedOptions.length) {
        item.value = clean(el.selectedOptions[0].text, VALUE_MAX);
      } else if (!secret && el.isContentEditable && tag !== 'input' && tag !== 'textarea') {
        const content = clean(el.innerText, VALUE_MAX);
        if (content) item.value = content;
      }
      if (type === 'checkbox' || type === 'radio' || lower(el.getAttribute('aria-checked')) === 'true') item.checked = !!el.checked || lower(el.getAttribute('aria-checked')) === 'true';
      if (el.disabled || lower(el.getAttribute('aria-disabled')) === 'true') item.disabled = true;
      const href = hrefOf(el);
      if (href) item.href = href;
      item.x = Math.round(rect.left);
      item.y = Math.round(rect.top);
      item.w = Math.round(rect.width);
      item.h = Math.round(rect.height);
      const form = describeForm(el);
      item.inForm = form.inForm === true;
      item.submit = isSubmit(el);
      if (form.post) item.post = true;
      if (form.sensitive) item.sensitive = true;
      if (form.near) item.near = form.near;
      elements.push(item);
    };

    for (const el of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= maxElements) {
        truncated = true;
        break;
      }
      const tag = lower(el.tagName);
      if (tag === 'input') {
        const t = inputType(el);
        if (t === 'hidden' || t === 'file') continue;
      }
      if (el.hasAttribute(REF_ATTR)) continue;
      const role = roleOf(el);
      // A bare [tabindex] or [role] on a structural element is not something to click; keep the controls.
      const tagControl = tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary';
      if (!tagControl && !ROLES.has(role) && role !== 'clickable' && !el.isContentEditable) continue;
      if (!tagControl && role === 'clickable' && !el.hasAttribute('onclick')) continue;
      if (tag === 'a' && !el.hasAttribute('href') && !el.hasAttribute('onclick') && !ROLES.has(role)) continue;
      if (!isVisible(el)) {
        if (!(tag === 'input' && (inputType(el) === 'checkbox' || inputType(el) === 'radio') && el.labels && el.labels.length)) continue;
      }
      if (tag === 'input' && inputType(el) === 'password') passwordVisible = true;
      take(el, role);
    }

    // Controls drawn as plain elements with a pointer cursor (a JS-only listener has no attribute to find it by). The outermost only.
    if (elements.length < maxElements) {
      let looked = 0;
      for (const el of document.querySelectorAll('div, span, li, td, img, svg, p, label, h1, h2, h3, h4')) {
        if (elements.length >= maxElements) {
          truncated = true;
          break;
        }
        if (looked++ > 4000) break;
        if (el.hasAttribute(REF_ATTR) || el.closest('[' + REF_ATTR + ']')) continue;
        if (!isVisible(el)) continue;
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        const parent = el.parentElement;
        if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4 || rect.width * rect.height > 400000) continue;
        take(el, 'clickable');
      }
    }

    if (!passwordVisible) {
      for (const f of document.querySelectorAll('input[type="password"]')) {
        if (isVisible(f)) {
          passwordVisible = true;
          break;
        }
      }
    }

    const body = document.body;
    const full = body ? String(body.innerText || '') : '';
    const captcha = CAPTCHA_RE.test(full) || !!document.querySelector('iframe[src*="captcha" i], iframe[src*="turnstile" i], .g-recaptcha, .h-captcha, .cf-turnstile');
    const root = document.scrollingElement || document.documentElement;
    return {
      url: location.href,
      title: clean(document.title, 300),
      text: full.length > maxChars ? full.slice(0, maxChars) : full,
      textCut: full.length > maxChars,
      elements,
      password: passwordVisible,
      captcha,
      truncated,
      scroll: { y: Math.round(root.scrollTop), height: Math.round(root.scrollHeight), view: Math.round(window.innerHeight) },
    };
  };

  // ---------- act ----------

  const scrollerAt = (x, y) => {
    let node = document.elementFromPoint(x, y);
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  // The element that has the focus now, looking through open shadow roots (document.activeElement alone names the host).
  const activeOf = () => {
    let node = document.activeElement;
    for (let i = 0; i < 8 && node && node.shadowRoot && node.shadowRoot.activeElement; i += 1) node = node.shadowRoot.activeElement;
    return node;
  };

  // True when the focus is on some other element than `el`: not `el`, not inside it, and not the page itself (nothing focused). A page's
  // own scripts can move the focus when a field takes it, and text typed goes where the focus is, not where the model aimed.
  const elsewhere = (el, active) =>
    !!active && active !== el && active !== document.body && active !== document.documentElement && !(el.contains && el.contains(active));

  const spotOf = el => ({ ref: el.getAttribute ? el.getAttribute(REF_ATTR) || '' : '', role: roleOf(el), name: nameOf(el) });

  // What a field that is about to be typed into looks like once the page has had its say: whether the text would go into `el`, and
  // whether the focus is on a password, code or card field (either `el` or the element the page moved the focus to).
  const focusState = el => {
    const active = activeOf();
    const moved = elsewhere(el, active);
    const out = { moved, secret: isSecret(el) || (moved && isSecret(active)) };
    if (moved) out.at = spotOf(active);
    return out;
  };

  // While text is typed (guard-on to guard-off) a listener in this isolated world watches for the page moving the focus or taking the
  // input somewhere else, which closes the gap between the check and the insert: a password, code or card field that takes the focus is
  // blurred, and an insert aimed at anything but the field is cancelled before it changes the page. It stops by itself after GUARD_MS.
  const GUARD_MAX = 20;
  const GUARD_MS = 10000;
  const stopGuard = () => {
    const old = window.__plenumGuard;
    if (!old) return;
    window.removeEventListener('focusin', old.onFocus, true);
    window.removeEventListener('beforeinput', old.onBefore, true);
    window.removeEventListener('input', old.onInput, true);
    window.__plenumGuard = undefined;
  };

  const focusInfo = el => {
    if (!el || el === document.body || el === document.documentElement) return { ok: true, none: true };
    const form = describeForm(el);
    return {
      ok: true,
      ref: el.getAttribute(REF_ATTR) || '',
      role: roleOf(el),
      name: nameOf(el),
      type: lower(el.tagName) === 'input' ? inputType(el) : '',
      secret: isSecret(el),
      editable: editable(el),
      inForm: form.inForm === true,
      submit: isSubmit(el),
      post: form.post === true,
      sensitive: form.sensitive === true,
      near: form.near || '',
    };
  };

  const act = args => {
    const a = args && typeof args === 'object' ? args : {};
    const action = String(a.action || '');
    if (action === 'scroll') {
      const direction = a.direction === 'up' ? -1 : 1;
      const amount = Math.max(1, Math.min(10, Math.floor(Number(a.amount)) || 3));
      const target = scrollerAt(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
      const before = target.scrollTop;
      target.scrollBy(0, direction * 600 * amount);
      const after = target.scrollTop;
      const max = Math.max(0, target.scrollHeight - target.clientHeight);
      return { ok: true, moved: Math.round(after - before), y: Math.round(after), max: Math.round(max), atTop: after <= 0, atBottom: after >= max - 2 };
    }
    if (action === 'focus-info') return focusInfo(activeOf());
    if (action === 'guard-off') {
      const state = window.__plenumGuard;
      // No state: the page was replaced since, and the guard went with it.
      if (!state) return { ok: true, gone: true, landed: false, strayed: false, secret: false, secretNow: false, moved: false };
      stopGuard();
      const active = activeOf();
      // A field the page replaced while the text went in (an editor that redraws itself) is not "moved".
      const away = state.el.isConnected !== false && elsewhere(state.el, active);
      // landed: an input event came from the ref. strayed: an insert aimed elsewhere was cancelled. secret: that, or a focus taken before
      // the text landed, was a password, code or card field. secretNow: such a field holds the focus now. moved: the focus is elsewhere.
      const out = { ok: true, landed: state.landed, strayed: state.strayed, secret: state.blocked, secretNow: !!active && active !== state.el && isSecret(active), moved: state.moved || away };
      // The field to name is the secret one when there is one (a field the guard blurred is no longer the active element).
      const at = out.secretNow ? spotOf(active) : state.at || (active && active !== document.body && active !== document.documentElement ? spotOf(active) : null);
      if (out.moved && at) out.at = at;
      return out;
    }
    if (action === 'arm-input') {
      const old = window.__plenumInput;
      if (old) for (const name of old.names) window.removeEventListener(name, old.handler, true);
      const state = { seen: false, names: a.kind === 'key' ? ['keydown'] : ['mousedown'], handler: null };
      state.handler = e => {
        if (e.isTrusted) state.seen = true;
      };
      for (const name of state.names) window.addEventListener(name, state.handler, true);
      window.__plenumInput = state;
      return { ok: true };
    }
    if (action === 'check-input') {
      const state = window.__plenumInput;
      // No state: the page was replaced since, which only the input can have done.
      if (!state) return { ok: true, seen: true, gone: true };
      if (a.keep !== true || state.seen === true) {
        for (const name of state.names) window.removeEventListener(name, state.handler, true);
        window.__plenumInput = undefined;
      }
      return { ok: true, seen: state.seen === true };
    }
    if (action === 'submit-form') {
      const active = document.activeElement;
      const form = active ? formOf(active) : null;
      if (!form) return { ok: false, message: 'There is no form around the focused field.' };
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return { ok: true };
    }

    const el = find(a.ref);
    if (!el) return gone(a.ref);
    const bad = mismatch(el, a.expect);
    if (bad) return bad;
    if (action === 'prepare-click') {
      if (el.disabled || lower(el.getAttribute('aria-disabled')) === 'true') return { ok: false, message: 'That control is disabled.' };
      const t = lower(el.tagName) === 'input' ? inputType(el) : '';
      if (t === 'file') return { ok: false, message: 'File pickers are not available to the model.' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1));
      const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1));
      const hit = document.elementFromPoint(x, y);
      const covered = !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      return { ok: true, x, y, covered };
    }
    if (action === 'dom-click') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true };
    }
    if (action === 'focus') {
      if (!editable(el)) return { ok: false, message: 'That control is not a text field. Use browser_click, or browser_select for a menu.' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (lower(el.tagName) === 'input' || lower(el.tagName) === 'textarea') {
        try {
          el.select();
        } catch (e) {
          // Some input types cannot select; the text is added at the cursor then.
        }
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      // The page's own scripts have run by now (a focus handler can move the focus to another field), so the answer is about where the
      // focus is, not about the field that was asked for: `secret` is true when either is a password, code or card field.
      return { ok: true, ...focusState(el), type: lower(el.tagName) === 'input' ? inputType(el) : '' };
    }
    if (action === 'guard-on') {
      stopGuard();
      const sees = e => (typeof e.composedPath === 'function' && e.composedPath()[0]) || e.target;
      const inside = t => t === el || (el.contains && el.contains(t)) || (t.isContentEditable === true && t.contains(el));
      const state = { el, moved: false, strayed: false, blocked: false, landed: false, at: null, count: 0, until: Date.now() + GUARD_MS, onFocus: null, onBefore: null, onInput: null };
      // Focus taken by another element before the text has landed in the ref: it is given up (a password, code or card field first of
      // all), so the insert has nowhere else to go. Once the text is in, a page that moves on (to the next field) is its own business.
      state.onFocus = e => {
        if (Date.now() > state.until) return stopGuard();
        const t = sees(e);
        if (!t || t === window || t === document || inside(t)) return;
        state.moved = true;
        if (state.landed) return;
        if (isSecret(t)) state.blocked = true;
        if (!state.at || state.blocked) state.at = spotOf(t);
        if (state.count < GUARD_MAX) {
          state.count += 1;
          try {
            t.blur();
            // A blurred field can keep the caret, and an insert then still goes into it: with no selection left it goes nowhere.
            window.getSelection().removeAllRanges();
          } catch (err) {
            // A node that cannot give up the focus keeps it; guard-off and the caller's checks still refuse.
          }
        }
      };
      // An insert aimed at anything but the ref is cancelled before it changes the page.
      state.onBefore = e => {
        if (Date.now() > state.until) return stopGuard();
        const t = sees(e);
        if (!t || inside(t)) return;
        state.moved = true;
        state.strayed = true;
        if (isSecret(t)) state.blocked = true;
        if (!state.at || state.blocked) state.at = spotOf(t);
        e.preventDefault();
      };
      state.onInput = e => {
        const t = sees(e);
        if (t && inside(t)) state.landed = true;
      };
      window.addEventListener('focusin', state.onFocus, true);
      window.addEventListener('beforeinput', state.onBefore, true);
      window.addEventListener('input', state.onInput, true);
      window.__plenumGuard = state;
      return { ok: true, ...focusState(el) };
    }
    if (action === 'read-value') {
      const secret = isSecret(el);
      const value = lower(el.tagName) === 'input' || lower(el.tagName) === 'textarea' ? el.value : el.innerText;
      return { ok: true, secret, value: secret ? '' : String(value || '').slice(0, 5000) };
    }
    if (action === 'set-value') {
      if (!editable(el)) return { ok: false, message: 'That control is not a text field.' };
      const text = String(a.text === undefined || a.text === null ? '' : a.text).slice(0, 5000);
      const tag = lower(el.tagName);
      if (tag === 'input' || tag === 'textarea') {
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, text);
        else el.value = text;
      } else {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    if (action === 'select') {
      if (lower(el.tagName) !== 'select') return { ok: false, message: 'That control is not a menu (select). Click it, then click the option.' };
      const want = String(a.value === undefined || a.value === null ? '' : a.value);
      const options = Array.prototype.slice.call(el.options);
      let found = options.find(o => o.value === want);
      if (!found) found = options.find(o => lower(clean(o.text, 200)) === lower(clean(want, 200)));
      if (!found) found = options.find(o => lower(clean(o.text, 200)).indexOf(lower(clean(want, 200))) >= 0 && want.length > 0);
      if (!found) {
        const list = options.slice(0, 12).map(o => '"' + clean(o.text, 40) + '"').join(', ');
        return { ok: false, message: 'No option "' + clean(want, 40) + '" in ' + clean(a.ref, 8) + '. Options: ' + list + (options.length > 12 ? ', …' : '') + '.' };
      }
      if (found.disabled) return { ok: false, message: 'That option is disabled.' };
      el.value = found.value;
      found.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, chosen: clean(found.text, 80) };
    }
    return { ok: false, message: 'The browser does not know that action.' };
  };

  return { snapshot, act };
})()
