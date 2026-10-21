// Per-project settings and tool options. Owned by the projects builder.
// The server calls these handlers before its own switch (see lib/routes/index.mjs), and each one answers the response itself.
import { TOOL_OPTIONS, chatModeOf, effectiveSettings, globalSettings, normalizeChatMode, normalizeProjectSettings, storedSettings } from '../projects.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The shape both endpoints return: the project's own settings (nulls where it inherits), what is in force, and the app's values.
function answer(store, project) {
  return {
    settings: storedSettings(project) ?? normalizeProjectSettings(null),
    effective: effectiveSettings(store.get(), project),
    global: globalSettings(store.get()),
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/tool-options',
    handler: ({ res, json }) => json(res, 200, TOOL_OPTIONS()),
  },
  {
    method: 'GET',
    path: '/api/project-settings',
    handler: ({ res, url, json, store, projectById, httpError }) => {
      const id = url.searchParams.get('project');
      if (!id) throw httpError(400, 'Choose a project first.');
      const project = projectById(id);
      if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
      return json(res, 200, answer(store, project));
    },
  },
  {
    method: 'POST',
    path: '/api/project-settings',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      // readBody gives back whatever the JSON was, so a bare null or a number is refused before any field is read.
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id and its settings.');
      const project = projectById(body.project);
      if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
      if (!isObject(body.settings)) throw httpError(400, 'Send the settings as an object, for example {"model": null, "effort": null, "approvals": null, "council": null, "relay": null, "tools": {}}.');
      let settings;
      try {
        settings = normalizeProjectSettings(body.settings);
      } catch (err) {
        throw httpError(400, err.message);
      }
      // chatMode belongs to the plan button, not to this panel. A save that does not mention it keeps the mode the project
      // has, so saving the panel never switches plan mode off by accident. Sending chatMode: 'normal' does switch it off.
      if (body.settings.chatMode === undefined && chatModeOf(project) === 'plan') settings.chatMode = 'plan';
      // The spend limits belong to the spend drawer (lib/routes/budget.mjs) in the same way, so this panel's save keeps them.
      if (body.settings.budget === undefined && isObject(project.settings?.budget)) settings.budget = project.settings.budget;
      // The whole object is replaced. The panel sends every field, and a field left out falls back to inherit or the defaults.
      project.settings = settings;
      await store.persist();
      return json(res, 200, answer(store, project));
    },
  },
  {
    // Changes only chatMode and leaves every other setting as it is, which is why it is not a use of POST /api/project-settings
    // (that route replaces the whole object). The mode is part of the project, so it survives a reload and a restart.
    method: 'POST',
    path: '/api/project-mode',
    handler: async ({ req, res, json, readBody, httpError, store, projectById }) => {
      // The server already refuses a POST without this header before any route runs. It is checked here as well, so the
      // route is safe on its own, as the checkpoints restore route is.
      if (req.headers['x-muse-console'] !== '1') throw httpError(403, 'Missing X-Muse-Console header.');
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the mode, for example {"project": "abc123", "mode": "plan"}.');
      const project = projectById(body.project);
      if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
      // A missing mode is refused, not read as normal: this route must never switch plan mode off by leaving a field out.
      if (typeof body.mode !== 'string' || body.mode.trim() === '') throw httpError(400, 'Send the mode: normal or plan.');
      let mode;
      try {
        mode = normalizeChatMode(body.mode);
      } catch (err) {
        throw httpError(400, err.message);
      }
      // Only the one key changes. The rest of the saved settings is copied as it is, valid or not, so a project whose
      // other settings no longer validate can still be put in plan mode.
      const next = isObject(project.settings) ? { ...project.settings } : {};
      if (mode === 'plan') next.chatMode = 'plan';
      else delete next.chatMode;
      // A project that has no other settings goes back to having none.
      if (Object.keys(next).length > 0) project.settings = next;
      else delete project.settings;
      await store.persist();
      return json(res, 200, { project: project.id, mode });
    },
  },
];
