// POST /api/stop-all { project? }: Stop everything, the way the Stop on a phone does (MOBILE.json decision.floor.additions). It ends every
// live computer or browser run, stops every agent, cancels every running reply (which denies the cards that reply was waiting on) and puts
// a notice on the events channel. With { project } it does the same for that one project. The answer is the four counts a STOP_ACK
// frame carries: { ok, cancelled, drivesStopped, agentsStopped, cardsDenied }. The server's running map has let go of the aborted runs
// by the time the answer is sent (it waits up to a second and a half for them), so a new message can be sent at once.
//
// The Agents pane's Stop all uses the same route. The work is lib/remote/stop.mjs, which needs no phone support, so this route works
// on a build that has none. It is the one write a Read-only phone may make (lib/remote/tiers.mjs).
//
// The server checks the Plenum token on every /api/ request and this handler checks it again (requireToken). The terms gate refuses it
// until the License Agreement is accepted, like every POST.
import { requireToken } from '../auth.mjs';
import { stopEverything } from '../remote/stop.mjs';

const WAIT_MS = 1500;

export const routes = [
  {
    method: 'POST',
    path: '/api/stop-all',
    handler: async ({ req, res, json, readBody, httpError, projectById, running, publicState }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Send a JSON object.');
      let project = null;
      if (body.project !== undefined && body.project !== null && body.project !== '') {
        if (typeof body.project !== 'string') throw httpError(400, 'project must be a project id.');
        project = projectById(body.project).id;
      }
      const counts = await stopEverything({
        project,
        running,
        port: req.socket.localPort,
        countCards: typeof publicState === 'function' ? () => publicState({ messages: false }).approvalsWaiting : undefined,
        waitMs: WAIT_MS,
      });
      return json(res, 200, { ok: true, ...counts });
    },
  },
];
