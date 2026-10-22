// Agent types and limits: the app's block and each project's own copy (lib/agents.mjs). GET /api/agents answers what is saved and
// what is in force (inForce says which settings the runs read yet); POST /api/agents saves one whole block (the app's, or a
// project's copy); POST /api/agents/customise gives a project its own copy of the app's values; POST /api/agents/reset drops the
// app's block or a project's copy. The server checks the Plenum token on every /api/ request, and each POST checks it again here,
// as the other routes do (requireToken).
import { CATALOG } from '../providers.mjs';
import { BUILT_IN, CEILINGS, IN_FORCE, RESEARCH_RANGE, ROLE_META, effectiveAgents, modelTools, normalizeAgents, resetTypeTo, tryNormalize } from '../agents.mjs';
import { requireToken } from '../auth.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// What the page needs. `project` is null when no project is named; `customised` is true only for a copy that validates, and
// `damaged` marks a saved copy that no longer validates (it is then not in force).
function answer(store, project) {
  const st = store.get();
  const app = tryNormalize(st.agents);
  const own = project ? tryNormalize(project.settings?.agents) : null;
  const rawOwn = project?.settings?.agents;
  return {
    app: app ?? normalizeAgents(null),
    appSaved: app !== null,
    project: project ? { id: project.id, name: project.name, customised: own !== null, damaged: own === null && rawOwn !== undefined && rawOwn !== null, agents: own } : null,
    effective: effectiveAgents(st, project),
    catalog: CATALOG.map(c => {
      const ref = `${c.provider}:${c.id}`;
      return { ref, label: c.label, provider: c.provider, tools: modelTools(ref) };
    }),
    roles: ROLE_META,
    ceilings: CEILINGS,
    research: RESEARCH_RANGE,
    builtIn: BUILT_IN.map(t => t.name),
    // What a saved setting changes today and what it does not yet change (the delegate tool reads part of it; see IN_FORCE).
    inForce: IN_FORCE,
    resets: Object.fromEntries(BUILT_IN.map(t => [t.name, resetTypeTo(t.name)])),
  };
}

// Sets or drops a project's own copy. The rest of its settings are kept as they are, valid or not, as the other project routes do.
function setProjectAgents(project, agents) {
  const next = isObject(project.settings) ? { ...project.settings } : {};
  if (agents) next.agents = agents;
  else delete next.agents;
  if (Object.keys(next).length > 0) project.settings = next;
  else delete project.settings;
}

export const routes = [
  {
    // Query: project (optional). Without it the answer is the app's block and the defaults.
    method: 'GET',
    path: '/api/agents',
    handler: ({ res, url, json, store, projectById }) => {
      const id = url.searchParams.get('project');
      const project = id ? projectById(id) : null;
      return json(res, 200, answer(store, project));
    },
  },
  {
    // Body: { scope: 'app' | 'project', project (for a project scope, or to reflect a project back), agents }. The whole block is
    // checked; a refusal is a 400 with the message.
    method: 'POST',
    path: '/api/agents',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the scope and the agent settings.');
      if (body.scope !== 'app' && body.scope !== 'project') throw httpError(400, 'scope must be app or project.');
      if (!isObject(body.agents)) throw httpError(400, 'Send the agent settings as an object with types and limits.');
      const project = body.project ? projectById(body.project) : null;
      if (body.scope === 'project' && !project) throw httpError(400, 'Choose a project first.');
      let agents;
      try {
        agents = normalizeAgents(body.agents);
      } catch (err) {
        throw httpError(400, err.message);
      }
      if (body.scope === 'app') store.get().agents = agents;
      else setProjectAgents(project, agents);
      await store.saveOrFail();
      return json(res, 200, answer(store, project));
    },
  },
  {
    // Body: { project }. Gives the project its own copy of the app's values as they are now. Refused when it already has a valid copy.
    method: 'POST',
    path: '/api/agents/customise',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id.');
      const project = projectById(body.project);
      if (tryNormalize(project.settings?.agents)) throw httpError(400, 'This project already has its own agent settings.');
      const { source, ...copy } = effectiveAgents(store.get(), null);
      void source;
      setProjectAgents(project, copy);
      await store.saveOrFail();
      return json(res, 200, answer(store, project));
    },
  },
  {
    // Body: { scope: 'app' | 'project', project }. The app's block is dropped (the defaults apply), or the project's copy.
    method: 'POST',
    path: '/api/agents/reset',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the scope and the project id.');
      if (body.scope !== 'app' && body.scope !== 'project') throw httpError(400, 'scope must be app or project.');
      const project = body.project ? projectById(body.project) : null;
      if (body.scope === 'app') delete store.get().agents;
      else {
        if (!project) throw httpError(400, 'Choose a project first.');
        setProjectAgents(project, null);
      }
      await store.saveOrFail();
      return json(res, 200, answer(store, project));
    },
  },
];
