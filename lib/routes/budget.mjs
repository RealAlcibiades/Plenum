// Spend limit routes: the state the top-bar chip shows, saving the warning and the cap for a project, and starting the
// running spend again. The rules are in lib/budget.mjs and lib/projects.mjs. The server checks X-Muse-Console on every POST
// before these handlers run.
import { budgetState, resetSpend } from '../budget.mjs';
import { normalizeProjectSettings } from '../projects.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  {
    method: 'GET',
    path: '/api/budget',
    handler: ({ res, url, json, store, projectById, httpError }) => {
      const id = url.searchParams.get('project');
      if (!id) throw httpError(400, 'Choose a project first.');
      const project = projectById(id);
      return json(res, 200, budgetState(project, store.transcript(project.id)));
    },
  },
  {
    // Body: { project, warnUsd, capUsd }. A blank or null amount is no limit. Both blank removes the limit.
    method: 'POST',
    path: '/api/budget',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id, warnUsd and capUsd.');
      const project = projectById(body.project);
      // Only the limit is checked here, so a stale setting this route does not own cannot refuse the save. The rest of the
      // saved settings is copied as it is, valid or not, the way lib/routes/projects.mjs changes plan mode.
      let budget;
      try {
        budget = normalizeProjectSettings({ budget: { warnUsd: body.warnUsd, capUsd: body.capUsd } }).budget ?? null;
      } catch (err) {
        throw httpError(400, err.message);
      }
      const next = isObject(project.settings) ? { ...project.settings } : {};
      if (budget) next.budget = budget;
      else delete next.budget;
      // A project that has no other settings goes back to having none.
      if (Object.keys(next).length > 0) project.settings = next;
      else delete project.settings;
      await store.saveOrFail();
      return json(res, 200, budgetState(project, store.transcript(project.id)));
    },
  },
  {
    // Body: { project }. Starts the running spend again from nothing, dated now. The limits are kept. The total keeps
    // counting after /clear, so this is the only way to start it again.
    method: 'POST',
    path: '/api/budget/reset',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id.');
      const project = projectById(body.project);
      resetSpend(project);
      await store.saveOrFail();
      return json(res, 200, budgetState(project, store.transcript(project.id)));
    },
  },
];
