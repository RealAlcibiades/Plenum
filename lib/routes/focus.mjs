// Build focus on or off for one project (lib/focus.mjs). Owned by the build-focus feature.
//   GET  /api/project-focus?project=ID  -> { project, on }
//   POST /api/project-focus { project, on } -> { project, on }
// The flag sits on the project record, not in project.settings, so POST /api/project-settings (which replaces the settings
// object) cannot turn it off, and lib/projects.mjs is not involved. Only the one key changes: on true sets it, on false removes it.
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well, the way
// POST /api/project-mode does, so the route is safe on its own.
import { buildFocusOf } from '../focus.mjs';
import { requireToken } from '../auth.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  {
    method: 'GET',
    path: '/api/project-focus',
    handler: ({ req, res, url, json, httpError, projectById }) => {
      requireToken(req, httpError);
      const id = url.searchParams.get('project');
      if (!id) throw httpError(400, 'Choose a project first.');
      const project = projectById(id);
      if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
      return json(res, 200, { project: project.id, on: buildFocusOf(project) });
    },
  },
  {
    method: 'POST',
    path: '/api/project-focus',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      requireToken(req, httpError);
      // readBody gives back whatever the JSON was, so a bare null, a string or an array is refused before any field is read.
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id and on, for example {"project": "abc123", "on": true}.');
      // A missing or non-boolean value is refused, never read as off: this route must not turn focus off by leaving a field out.
      if (typeof body.on !== 'boolean') throw httpError(400, 'Send on: true or false.');
      const project = projectById(body.project);
      if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
      if (body.on) project.buildFocus = true;
      else delete project.buildFocus;
      await store.saveOrFail();
      return json(res, 200, { project: project.id, on: buildFocusOf(project) });
    },
  },
];
