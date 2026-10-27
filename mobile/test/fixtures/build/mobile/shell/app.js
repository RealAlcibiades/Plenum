// Fixture shell entry. It imports a sibling module and a shared remote module through the ./remote/ path that the
// build maps to lib/remote (no copy of noise.mjs sits in mobile/shell).
import { greet } from './greet.js';
import { FIXTURE_NOISE } from './remote/noise.mjs';

window.fixtureShell = { greeting: greet(), noise: FIXTURE_NOISE, version: __PLENUM_SHELL_VERSION__ };
