// Rules panel routes (Settings > Rules): the project's rules files and the global rules. The logic is in lib/rules.mjs.
// Saves are refused while the project runs. Plan mode does not refuse the person's own save (amendment 31): plan mode binds the
// model, not the person, so a rules file saved here is written with the same checkpoint as outside plan mode.
// Both POST routes check the Plenum token themselves (requireToken), so each is safe on its own; the server checks it too.
import { chatModeOf, denyPatternsOf } from '../projects.mjs';
import { forgetProjectSessions } from '../sessions.mjs';
import { requireToken } from '../auth.mjs';
import {
  GLOBAL_FILE,
  GLOBAL_MAX_CHARS,
  PROJECT_MAX_CHARS,
  RulesError,
  SAVE_MAX_CHARS,
  listProjectRules,
  readGlobalRules,
  saveGlobalRules,
  saveProjectRules,
} from '../rules.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A refusal from lib/rules.mjs keeps its status and message. Any other failure is logged and answered without its detail.
function failure(httpError, err) {
  if (err instanceof RulesError) return httpError(err.status, err.message);
  console.error('Rules: a save failed:', err?.message ?? err);
  return httpError(500, 'Plenum could not save the file. Try again.');
}

export const routes = [
  {
    // Query: project=ID. Answers the project's three rules files, the global rules and the limits the panel shows.
    method: 'GET',
    path: '/api/rules',
    handler: async ({ req, res, url, json, httpError, projectById, running }) => {
      requireToken(req, httpError);
      const id = url.searchParams.get('project');
      if (!id) throw httpError(400, 'Choose a project first.');
      const project = projectById(id);
      return json(res, 200, {
        project: {
          id: project.id,
          name: project.name,
          path: project.path,
          plan: chatModeOf(project) === 'plan',
          running: running.has(project.id),
        },
        files: await listProjectRules(project.path),
        global: await readGlobalRules(),
        limits: { projectChars: PROJECT_MAX_CHARS, saveChars: SAVE_MAX_CHARS, globalChars: GLOBAL_MAX_CHARS },
        denyPatterns: denyPatternsOf(project).length,
        globalFile: GLOBAL_FILE,
      });
    },
  },
  {
    // Body: { project, name, text, seen }. name is one of the three rules files; seen is the hash the panel loaded.
    method: 'POST',
    path: '/api/rules',
    handler: async ({ req, res, json, readBody, httpError, projectById, running }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the project id, the file name, its text and the hash you loaded.');
      const project = projectById(body.project);
      if (running.has(project.id)) throw httpError(409, 'This project is running. Use /cancel first.');
      let file;
      try {
        file = await saveProjectRules({ projectId: project.id, projectPath: project.path, name: body.name, text: body.text, seen: body.seen });
      } catch (err) {
        throw failure(httpError, err);
      }
      // A native Codex or Claude session keeps the rules it started with, so the next message starts a new one (lib/sessions.mjs).
      forgetProjectSessions(project.id);
      return json(res, 200, { ok: true, file });
    },
  },
  {
    // Body: { text, seen }. The global rules are the same for every project, so no project is named and no run is checked.
    method: 'POST',
    path: '/api/rules/global',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the text and the hash you loaded.');
      let global;
      try {
        global = await saveGlobalRules({ text: body.text, seen: body.seen });
      } catch (err) {
        throw failure(httpError, err);
      }
      for (const project of store.get().projects ?? []) forgetProjectSessions(project.id);
      return json(res, 200, { ok: true, global });
    },
  },
];
