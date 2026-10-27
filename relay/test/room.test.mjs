// The relay under miniflare: the real Worker and Durable Object under workerd,
// on 127.0.0.1 with random ports. Nothing reaches Cloudflare.
// Mandatory wherever workerd runs (CI on Linux). On Windows the pinned workerd (1.20260730.1) exits as soon as it is started on the
// build machine, so nothing is started there and the battery reports every scenario as skipped with that reason.
// RELAY_REQUIRE_MINIFLARE=1 runs it on Windows as well, and then a workerd that does not start fails the run.
import { after, before } from 'node:test';
import { scenarios } from './support/scenarios.mjs';

const required = process.env.RELAY_REQUIRE_MINIFLARE === '1';
const skip = process.platform === 'win32' && !required
  ? 'miniflare is skipped on Windows: the pinned workerd exits at startup on this machine (set RELAY_REQUIRE_MINIFLARE=1 to run it)'
  : false;
// CI (.github/workflows/mobile.yml sets RELAY_REQUIRE_MINIFLARE=1 on the relay step) never skips this suite, whatever the runner: a skipped
// battery would read as a pass without workerd ever having run.
if (skip && process.env.CI) throw new Error('The miniflare relay suite is required on CI: set RELAY_REQUIRE_MINIFLARE=1 for this step.');

// Filled in by the before hook. The miniflare driver (and the miniflare package) is imported only when the battery runs, so a skipped
// run needs neither workerd nor relay/node_modules.
const driver = {};
let stop = null;
before(async () => {
  if (skip) return;
  const { createMiniflareDriver } = await import('./support/miniflare-driver.mjs');
  const mf = createMiniflareDriver();
  Object.assign(driver, mf);
  stop = () => mf.stop();
  await mf.start();
}, { timeout: 60_000 });
after(async () => {
  if (stop) await stop();
});
scenarios(driver, 'miniflare', { skip });
