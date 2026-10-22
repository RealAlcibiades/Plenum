// The API finder: GET /api/finder answers every price source and the model comparison, and GET /api/finder/endpoints?id= answers the
// providers OpenRouter routes one model to. See lib/price-feeds.mjs and lib/router-directory.mjs for what each source is.
// Nothing is fetched at app start: the first read happens when the finder panel asks. Upstream failures are never an HTTP error; they
// are reported in sources, and a page keeps the last good list. Neither route sends a key or reads one. Both ask for the Plenum token,
// so a page from another site cannot make Plenum read the lists.
import { apiProvider } from '../api-providers.mjs';
import { requireToken } from '../auth.mjs';
import { PRICES } from '../pricing.mjs';
import { listCatalog, listEndpoints } from '../openrouter.mjs';
import { FEEDS, buildComparison, directOffers, getFeed } from '../price-feeds.mjs';
import { DIRECTORY, directProviders } from '../router-directory.mjs';

export const routes = [
  { method: 'GET', path: '/api/finder', handler: finderRoute },
  { method: 'GET', path: '/api/finder/endpoints', handler: endpointsRoute },
];

// The server already refuses any /api/ request without the token before a route runs. It is checked here as well, so these
// routes are safe on their own, the way the other read routes are.
function requireHeader(req, httpError) {
  requireToken(req, httpError);
}

// The sources in the order the page shows them: OpenRouter first, then the three feeds. Each keeps its own read time, count and state.
const sourceOf = (id, name, answer, count) => ({
  id,
  name,
  ok: answer.ok,
  at: answer.at,
  stale: answer.stale,
  count,
  message: answer.message || '',
});

async function finderRoute({ req, res, url, json, httpError }) {
  requireHeader(req, httpError);
  const force = url.searchParams.get('refresh') === '1';
  const [or, ...fs] = await Promise.all([listCatalog({ force }), ...FEEDS.map(f => getFeed(f.id, { force }))]);
  const feeds = Object.fromEntries(FEEDS.map((f, i) => [f.id, fs[i].offers]));
  const models = buildComparison({ openrouter: or.models, feeds, direct: directOffers() });
  const sources = [
    sourceOf('openrouter', 'OpenRouter', or, or.models.length),
    ...fs.map(f => sourceOf(f.id, f.name, f, f.offers.length)),
  ];
  const stamps = sources.map(s => s.at).filter(at => typeof at === 'number');
  const readAt = stamps.length ? Math.max(...stamps) : null;
  const oldestAt = stamps.length ? Math.min(...stamps) : null;
  // A refresh was asked for, and no source was asked again: each was read inside the last minute or is inside its failure back-off.
  const throttled = force && !or.fetched && !fs.some(f => f.fetched);
  const routers = DIRECTORY.routers.map(r => {
    const live = r.feed ? sources.find(s => s.id === r.feed) : null;
    return { ...r, liveCount: live ? live.count : null, liveAt: live?.at ?? null, liveOk: live ? live.ok : null };
  });
  return json(res, 200, {
    sources,
    readAt,
    oldestAt,
    throttled,
    models,
    openrouterTools: apiProvider('openrouter')?.toolsVerified === true,
    directory: { checkedOn: DIRECTORY.checkedOn, routers },
    direct: { checkedOn: PRICES.checkedOn, providers: directProviders() },
  });
}

// The providers behind one OpenRouter model. The id is matched against OpenRouter's own list before anything is asked, and a ':free'
// style suffix is taken off for the endpoints request. Nothing from the request reaches a URL unless it is a listed model id.
async function endpointsRoute({ req, res, url, json, httpError }) {
  requireHeader(req, httpError);
  const raw = String(url.searchParams.get('id') ?? '').slice(0, 200);
  const base = raw.replace(/:[A-Za-z0-9-]{1,20}$/, '');
  const cat = await listCatalog();
  if (!cat.models.length) throw httpError(503, cat.message || "OpenRouter's model list has not been read yet. Press Refresh first.");
  if (!cat.models.some(m => m.id === raw || m.id === base)) throw httpError(400, "That model is not in OpenRouter's list.");
  return json(res, 200, { id: base, ...(await listEndpoints(base)) });
}
