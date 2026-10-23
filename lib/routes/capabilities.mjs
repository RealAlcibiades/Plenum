// Which models take images and PDFs (lib/capabilities.mjs), for the attach chip under the composer. Reading it sends nothing to any
// provider and makes no network call: the table is in the code, and OpenRouter's rows come from lists kept in memory.
//   GET /api/capabilities -> { checkedOn, models: { [ref]: { image, why, mimes, pdf } } }
//     image: true when Plenum may send an image to the model; why says why not otherwise; mimes are the types it takes;
//     pdf: 'native' (Claude through an API key) or 'text' (Plenum reads the PDF's text for the model).
// Every catalog model is listed, and every OpenRouter model whose list was kept in the last ten minutes.
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well.
import { requireToken } from '../auth.mjs';
import { CATALOG } from '../providers.mjs';
import { claudeRoute } from '../claude-cli.mjs';
import { CAPABILITIES, imageSupport, pdfSupport } from '../capabilities.mjs';
import { openRouterKeptIds } from '../openrouter.mjs';

export async function capabilitiesAnswer(now = Date.now()) {
  const route = await claudeRoute();
  const refs = [
    ...CATALOG.map(c => `${c.provider}:${c.id}`),
    ...openRouterKeptIds(now).map(id => `openrouter:${id}`),
  ];
  const models = {};
  for (const ref of refs) {
    const support = imageSupport(ref);
    models[ref] = {
      image: support.ok,
      why: support.ok ? null : support.why,
      mimes: [...support.mimes],
      pdf: pdfSupport(ref, route),
    };
  }
  return { checkedOn: CAPABILITIES.checkedOn, models };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/capabilities',
    handler: async ({ req, res, json, httpError }) => {
      requireToken(req, httpError);
      return json(res, 200, await capabilitiesAnswer());
    },
  },
];
