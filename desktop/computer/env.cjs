'use strict';
// The environment every helper process of the computer-use backend runs with (lsappinfo, ps and xdotool, always through execFile with
// a fixed argument list). It is the shell's own environment with every key, token and sign-in setting removed, so a helper can never
// inherit one. The rules are the ones lib/proc.mjs childEnv applies to a coding agent, copied here because this file is CommonJS and
// loads in the Electron main process, which does not import lib/. Names are compared in upper case (Windows ignores case).

// Variables removed by name or by prefix (a prefix ends in "_").
const DROP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'GEMINI_', 'GOOGLE_GENAI_', 'AWS_', 'AZURE_', 'MUSE_CONSOLE_', 'PLENUM_'];
const DROP_NAMES = [
  'CLAUDECODE', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
  'META_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
];
// Any variable named like a secret goes too.
const SECRET_SUFFIX = /(_API_KEY|_APIKEY|_TOKEN|_SECRET|_SECRET_KEY|_PASSWORD|_PASSWD|_CREDENTIALS)$/;

function isSecretName(name) {
  const upper = String(name).toUpperCase();
  return DROP_NAMES.includes(upper) || DROP_PREFIXES.some(prefix => upper.startsWith(prefix)) || SECRET_SUFFIX.test(upper);
}

// A copy of `source` (default: this process's environment) without any key, token or sign-in setting.
function cleanEnv(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value === 'string' && !isSecretName(name)) env[name] = value;
  }
  return env;
}

module.exports = { cleanEnv, isSecretName };
