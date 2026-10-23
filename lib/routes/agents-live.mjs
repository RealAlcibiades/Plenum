// The agents that are running now (lib/agent-run.mjs): GET /api/agents/live?project= lists them, and POST /api/agents/stop { project, id }
// stops one ('all' stops every agent of the project). The list is the table the runner counts its limits with, so what a window shows is
// what the limits count; the same changes also arrive as { type: 'agent' } events on GET /api/events. A stop aborts only that agent's own
// controller: the model that asked is told the agent was stopped and carries on. An agent that runs inside Claude Code cannot be stopped
// on its own (Plenum does not run it); Esc stops the whole reply. The server checks the Plenum token on every /api/ request, and the
// POST checks it again here, as the other routes do (requireToken).
import { liveAgents, stopAgent, stopAll } from '../agent-run.mjs';
import { requireToken } from '../auth.mjs';

export const routes = [
  {
    // Query: project (required). The answer is { agents: [...] }, oldest first; each has elapsedMs and state.
    method: 'GET',
    path: '/api/agents/live',
    handler: ({ res, url, json, projectById }) => {
      const project = projectById(url.searchParams.get('project'));
      return json(res, 200, { agents: liveAgents(project.id) });
    },
  },
  {
    // Body: { project, id } with id an agent id or 'all'. 404 when that agent is not running, 409 for one inside Claude Code.
    method: 'POST',
    path: '/api/agents/stop',
    handler: async ({ req, res, json, readBody, httpError, projectById }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      const project = projectById(body?.project);
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!id) throw httpError(400, 'Say which agent to stop, or send id "all".');
      if (id === 'all') return json(res, 200, { stopped: stopAll(project.id) });
      const row = liveAgents(project.id).find(a => a.id === id);
      if (!row) throw httpError(404, 'That agent is not running.');
      if (row.stoppable === false) throw httpError(409, 'This agent runs inside Claude Code and cannot be stopped on its own. Stop the whole reply with Esc.');
      if (!stopAgent(project.id, id)) throw httpError(404, 'That agent is not running.');
      return json(res, 200, { stopped: 1 });
    },
  },
];
