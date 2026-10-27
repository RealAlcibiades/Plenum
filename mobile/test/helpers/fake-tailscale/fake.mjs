// The fake Tailscale CLI for the carriers suite (mob-04). It is never the real tailscale: the test puts this folder first on a scratch PATH
// and the shims run this file with the node binary the test names (TS_FAKE_NODE). Every call appends its exact argv, as JSON, to the
// file named by TS_FAKE_LOG, so the suite can count what ran. Behaviour is chosen by environment variables the test sets:
//   TS_FAKE_STATUS=running (default) | needslogin | stopped   what `status --json` reports
//   TS_FAKE_FAIL=serve                                       `serve ...` exits 1 with a message
// Nothing here reaches the network or any account.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.TS_FAKE_LOG) appendFileSync(process.env.TS_FAKE_LOG, `${JSON.stringify({ argv })}\n`);

const dns = 'will-pc.tail1234.ts.net.';
const state = process.env.TS_FAKE_STATUS ?? 'running';
const backend = state === 'needslogin' ? 'NeedsLogin' : state === 'stopped' ? 'Stopped' : 'Running';

if (argv[0] === 'status' && argv[1] === '--json') {
  process.stdout.write(`${JSON.stringify({ BackendState: backend, Self: { DNSName: dns, Online: backend === 'Running' } })}\n`);
  process.exit(0);
}
if (argv[0] === 'serve') {
  if (process.env.TS_FAKE_FAIL === 'serve') {
    process.stderr.write('fake tailscale: serve refused for this test\n');
    process.exit(1);
  }
  process.stdout.write('Available within your tailnet\n');
  process.exit(0);
}
process.stderr.write(`fake tailscale: unknown command ${argv.join(' ')}\n`);
process.exit(2);
