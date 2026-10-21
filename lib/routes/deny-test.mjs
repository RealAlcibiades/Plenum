// Dry-run tester for blocked commands: POST /api/deny/test { project, command } says whether a built-in rule or one of the
// project's own patterns would block the command. This is a pure check through checkCommand. Nothing is run, written or
// changed here, and no pattern is saved. The server checks X-Muse-Console on every POST before this handler runs.
import { checkCommand } from '../denylist.mjs';
import { denyPatternsOf } from '../projects.mjs';

export const MAX_COMMAND_CHARS = 2000;

// Control characters other than tab, newline and carriage return. A carriage return is turned into a newline below, because
// the check reads it as a break between commands and the tester should read the line the way a run does.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const CUSTOM = /^custom pattern "([\s\S]*)"$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'POST', path: '/api/deny/test', handler: testRoute },
];

async function testRoute({ req, res, json, readBody, httpError, projectById }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send an object with the project id and the command.');
  const project = projectById(body.project);
  if (!project) throw httpError(400, 'No such project. Add a folder with /add <path>.');
  const { command } = body;
  const tooBig = typeof command === 'string' && command.length > MAX_COMMAND_CHARS;
  const line = typeof command === 'string' ? command.replace(/\r\n?/g, '\n').replace(CONTROL, '') : '';
  if (typeof command !== 'string' || tooBig || line.trim() === '') {
    throw httpError(400, `Type a command of at most ${MAX_COMMAND_CHARS} characters.`);
  }
  // A run passes the project folder as the root, so a delete of the project itself is read the same way here.
  const options = typeof project.path === 'string' && project.path ? { projectRoot: project.path } : {};

  const builtIn = checkCommand(line, [], options);
  if (builtIn.blocked) return json(res, 200, { blocked: true, source: 'built-in', rule: String(builtIn.rule) });

  const own = checkCommand(line, denyPatternsOf(project), options);
  if (own.blocked) {
    // The check names a pattern as: custom pattern "<text>". The panel words it as the pattern, so only the text is sent.
    const rule = String(own.rule);
    return json(res, 200, { blocked: true, source: 'project', rule: rule.replace(CUSTOM, '$1') });
  }
  return json(res, 200, { blocked: false, source: null, rule: null });
}
