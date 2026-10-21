// Token and cost display. Loaded by ext.js and adds itself through window.MuseUI.
// A small line in the top bar shows the active project's running total. Its title holds the breakdown and the last reply's
// usage. The server works every number out (lib/pricing.mjs, from the published prices) and sends it in the state the page
// already fetches: state.usage[projectId] is the project's total, and each saved reply carries its own usage in
// state.messages. This file keeps no copy of any of it and does no pricing; it only reads and words what the server sent.
//   API models are billed per token. Their dollar figures are estimates from the published price and say so.
//   Subscription CLIs (Claude Code, Codex, Gemini CLI, Muse Code) are plan use: tokens only, never a dollar amount.
//   A model that reports no tokens shows "not reported". Nothing here estimates tokens or prices.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const ESTIMATE = 'estimated from the published price';
  const SCOPE = 'chat and review replies; council, build and relay replies are not counted';

  // The line is a few spans in order of importance: the total and its estimate label first, then the plan tokens, then the last
  // reply. A narrow window cuts from the right, so the later parts go first (see ext-cost.css). All text goes in with textContent.
  const line = document.createElement('span');
  line.className = 'cost-line';
  line.hidden = true;
  const parts = {};
  for (const name of ['main', 'note', 'est', 'plan', 'last']) {
    parts[name] = document.createElement('span');
    parts[name].className = `cost-${name}`;
    line.append(parts[name]);
  }
  // Right after the project name, before the folder path.
  MuseUI.el.projName.after(line);

  const num = n => Number(n || 0).toLocaleString('en-US');
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

  // 1234 -> "1.2K", 52300 -> "52K", 3100000 -> "3.1M".
  function tokens(n) {
    const v = Number(n || 0);
    if (v < 1000) return String(v);
    if (v < 1_000_000) return `${+(v / 1000).toFixed(v < 100_000 ? 1 : 0)}K`;
    return `${+(v / 1_000_000).toFixed(2)}M`;
  }

  function dollars(n) {
    if (!n) return '$0.00';
    if (n < 0.0001) return '<$0.0001';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
  }

  // A per-million rate, such as "$2.00 in, $10.00 out, $0.10 cached per million tokens (prompt up to 100K)".
  const price = n => `$${Number(n).toFixed(n < 0.1 ? 3 : 2)}`;
  const rateText = r => `${price(r.input)} in, ${price(r.output)} out, ${price(r.cached)} cached per million tokens${r.label ? ` (${r.label})` : ''}`;

  // ---------- the visible line ----------

  // { api, plan }: "API $0.042" and "plan use 145K tokens", each empty when the project has no such replies. A reply the
  // server could not price or count is said so, not hidden.
  function totalText(t) {
    let api = '';
    const a = t.api;
    if (a.replies) {
      const unpriced = a.replies - a.priced;
      if (a.priced) api = `API ${dollars(a.dollars)}${unpriced ? ` (+${unpriced} unpriced)` : ''}`;
      else if (a.unpublished) api = 'API price not published';
      else api = 'API tokens not reported';
    }
    let plan = '';
    const p = t.plan;
    if (p.replies) {
      const used = p.input + p.output;
      plan = used ? `plan use ${tokens(used)} tokens${p.unreported ? ` (+${p.unreported} not reported)` : ''}` : 'plan use, tokens not reported';
    }
    return { api, plan };
  }

  // The last reply in a few words.
  function replyText(u) {
    if (u.billing === 'plan') return u.reported ? `plan use ${tokens(u.input + u.output)} tokens` : 'plan use, tokens not reported';
    if (!u.reported) return 'tokens not reported';
    if (typeof u.cost?.dollars === 'number') return dollars(u.cost.dollars);
    return `${tokens(u.input + u.output)} tokens, ${u.cost?.reason ?? 'price not published'}`;
  }

  // ---------- the title ----------

  function totalLines(t) {
    const out = [`Total for this project's chat: ${plural(t.replies, 'reply', 'replies')} (${SCOPE}).`];
    const a = t.api;
    if (a.replies) {
      const head = `API models: ${plural(a.replies, 'reply', 'replies')}`;
      if (a.priced || a.input || a.output) {
        out.push(`${head}, ${num(a.input)} tokens in (${num(a.cached)} cached), ${num(a.output)} tokens out${a.priced ? `, ${dollars(a.dollars)} ${ESTIMATE}` : ''}.`);
      } else {
        out.push(`${head}: tokens not reported.`);
      }
      if (a.unpublished) {
        const names = t.unpublishedModels?.length ? ` (${t.unpublishedModels.join(', ')})` : '';
        out.push(`${plural(a.unpublished, 'API reply has', 'API replies have')} no published price${names}, so no cost is shown for ${a.unpublished === 1 ? 'it' : 'them'}.`);
      }
      if (a.unreported && (a.priced || a.unpublished)) out.push(`${plural(a.unreported, 'API reply', 'API replies')} did not report tokens.`);
      if (a.priced) out.push(`Prices checked ${t.checkedOn}.`);
    }
    const p = t.plan;
    if (p.replies) {
      const used = p.input + p.output;
      out.push(used
        ? `Plan use (subscription CLIs): ${plural(p.replies, 'reply', 'replies')}, ${num(p.input)} tokens in (${num(p.cached)} cached), ${num(p.output)} tokens out. Plan use shows tokens only, never a dollar amount.`
        : `Plan use (subscription CLIs): ${plural(p.replies, 'reply', 'replies')}, tokens not reported. Plan use never shows a dollar amount.`);
      if (used && p.unreported) out.push(`${plural(p.unreported, 'plan reply', 'plan replies')} did not report tokens.`);
    }
    return out;
  }

  function replyLines(m) {
    const u = m.usage;
    const who = (typeof MuseUI.modelName === 'function' && MuseUI.modelName(m.model)) || m.model || 'the model';
    const head = `Last reply (${who}):`;
    const out = [];
    if (!u.reported) {
      out.push(`${head} ${u.billing === 'plan' ? 'plan use, ' : ''}tokens not reported by this model.`);
    } else {
      const tok = `${num(u.input)} tokens in (${num(u.cached)} cached), ${num(u.output)} tokens out, ${plural(u.requests, 'request', 'requests')}`;
      if (u.billing === 'plan') {
        out.push(`${head} plan use, ${tok}. Plan use shows tokens only, never a dollar amount.`);
      } else if (typeof u.cost?.dollars === 'number') {
        out.push(`${head} ${tok}.`);
        out.push(`${dollars(u.cost.dollars)} ${ESTIMATE}.`);
        for (const r of u.cost.rates ?? [u.cost.rate]) if (r) out.push(`Rate used: ${rateText(r)}.`);
        if (u.cost.note) out.push(u.cost.note);
      } else {
        out.push(`${head} ${tok}.`);
        out.push(`No cost shown: ${u.cost?.reason ?? 'price not published'}.`);
      }
    }
    if (u.partial) out.push('This reply was stopped or failed, so tokens for the request in progress may be missing.');
    return out;
  }

  // The newest reply from a model that could carry usage. A reply with none (an offline echo, a relayed reply) shows no
  // "last reply", so an older reply is never passed off as the latest.
  function lastReply(messages) {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.kind !== 'council' && m.kind !== 'build') return m.usage ? m : null;
    }
    return null;
  }

  function paint() {
    const st = MuseUI.state ?? {};
    const t = st.usage?.[st.activeProject];
    if (!t || !t.replies) {
      line.hidden = true;
      for (const part of Object.values(parts)) part.textContent = '';
      line.title = '';
      return;
    }
    const m = lastReply(st.messages);
    const { api, plan } = totalText(t);
    parts.main.textContent = `Project: ${api || plan}`;
    // The estimate label sits right after the API figure, in full when there is room and as "est." when there is not.
    // The last reply's dollar figure, when it has one, is one of the priced replies counted in t.api.
    parts.note.textContent = t.api.priced > 0 ? ` ${ESTIMATE}` : '';
    parts.est.textContent = t.api.priced > 0 ? ' est.' : '';
    parts.plan.textContent = api && plan ? ` · ${plan}` : '';
    parts.last.textContent = m ? ` · last reply ${replyText(m.usage)}` : '';
    line.title = [...totalLines(t), ...(m ? ['', ...replyLines(m)] : [])].join('\n');
    line.hidden = false;
  }

  // The page redraws its top bar whenever it reads the state again (a reload, a project switch, the end of a run), so the
  // line follows the same changes. The line is not inside the project name, so painting cannot trigger the observer.
  new MutationObserver(paint).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });
  paint();
})();
