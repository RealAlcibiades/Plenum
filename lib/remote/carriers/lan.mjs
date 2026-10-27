// The same-network carrier (MOBILE.json desktop.new_files, lib/remote/carriers/lan.mjs; feature mob-04). Owned by mob-04.
//
// What it does. With "Allow phones on this network" on, it asks the Bridge's listener for LAN mode (ctx.listener.setLan) and reports
// the addresses this computer has on private networks: they become the ws:// candidates in the pairing QR and the LAN web page link.
// It never chooses an address to bind and holds no key. The listener binds 0.0.0.0 and :: in LAN mode (its lanHosts option, supplied by
// the Bridge); a sealed test run binds loopback only (MOBILE_SEALED=1, lib/remote/listener.mjs), unless PLENUM_TEST_REAL_LAN=1 (CI).
//
// Addresses. Interfaces come from `interfaces` (os.networkInterfaces() by default; a test injects its own list). Candidates are private
// IPv4 (10/8, 172.16/12, 192.168/16) and unique-local IPv6 (fc00::/7); link-local, CGNAT (a VPN's 100.64/10), loopback and public
// addresses are never offered, because a phone on the same network cannot reach them and a web URL cannot carry an IPv6 zone.
//
// Windows. The first bind on the wildcard address can make Windows Firewall ask whether to allow Plenum on private networks. The
// FIREWALL_TEXT sentence says so; the phone-lan notice carries the same warning.
//
// Nothing here logs an address, a key, a path key or a name.
import os from 'node:os';
import { normalizeAddress } from '../listener.mjs';

export const MAX_CANDIDATES = 4;
export const FIREWALL_TEXT = 'Windows may ask whether to allow Plenum through the firewall on private networks. Allow it only on networks you trust; a phone still needs a paired key to get in.';

const LAN_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const ULA_IPV6 = /^f[cd][0-9a-f]{2}:/;
const RANK = Object.freeze({ '192.168.': 0, '10.': 1, '172.': 2 });

export function isLanIPv4(address) {
  return LAN_IPV4.test(address) && /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

export function isUniqueLocalIPv6(address) {
  return ULA_IPV6.test(address);
}

const rankOf = address => {
  for (const [prefix, rank] of Object.entries(RANK)) if (address.startsWith(prefix)) return rank;
  return 3;
};

// The private candidate addresses of an os.networkInterfaces()-shaped object, best first, without duplicates.
export function candidatesOf(interfaces = {}) {
  const found = new Map();
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const info of Array.isArray(list) ? list : []) {
      if (!info || info.internal === true) continue;
      const family = info.family === 'IPv4' || info.family === 4 ? 'IPv4' : 'IPv6';
      const address = normalizeAddress(info.address);
      if (!address) continue;
      if (family === 'IPv4' ? !isLanIPv4(address) : !isUniqueLocalIPv6(address)) continue;
      if (!found.has(address)) found.set(address, { address, family, name: String(name).slice(0, 40) });
    }
  }
  return [...found.values()]
    .map(c => ({ ...c, rank: c.family === 'IPv4' ? rankOf(c.address) : 4 }))
    .sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address))
    .map(({ rank, ...c }) => c)
    .slice(0, MAX_CANDIDATES);
}

// The host part of a URL: IPv6 literals in brackets.
export const hostOf = address => (address.includes(':') ? `[${address}]` : address);

/**
 * @param {object} [options]
 * @param {() => object} [options.interfaces]   returns an os.networkInterfaces()-shaped object (default os.networkInterfaces)
 */
export function createLanCarrier(options = {}) {
  const readInterfaces = options.interfaces ?? (() => os.networkInterfaces());
  let ctx = null; // the context of the last start, for the port, the path key and the listener
  let on = false; // LAN mode is on in the listener
  let anyAddress = false;
  let addresses = [];
  let error = '';
  let queue = Promise.resolve();

  const serial = fn => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function refresh() {
    try {
      addresses = candidatesOf(readInterfaces());
    } catch {
      addresses = [];
    }
    return addresses;
  }

  function status() {
    refresh();
    return {
      on,
      anyAddress,
      addresses: addresses.map(c => c.address),
      port: ctx?.listener?.port?.() || 0,
      firewall: on ? FIREWALL_TEXT : '',
      error,
    };
  }

  async function setListener(next) {
    try {
      await next.listener.setLan(next.value);
      return '';
    } catch (err) {
      return typeof err?.code === 'string' ? err.code : 'bind-failed';
    }
  }

  function start(next) {
    return serial(async () => {
      ctx = next;
      const want = next.settings?.() ?? {};
      if (want.enabled !== true) {
        await leave(next);
        return status();
      }
      anyAddress = want.anyAddress === true;
      error = await setListener({ listener: next.listener, value: { enabled: true, anyAddress } });
      on = error === '';
      refresh();
      return status();
    });
  }

  async function leave(target) {
    on = false;
    error = '';
    const use = target ?? ctx;
    if (use?.listener) {
      await setListener({ listener: use.listener, value: { enabled: false, anyAddress: false } });
    }
    anyAddress = false;
  }

  // stop() with no context (the Bridge is closing) leaves the listener to its own stop.
  function stop(target) {
    return serial(async () => {
      if (target) ctx = target;
      await leave(target);
      return status();
    });
  }

  // The QR candidates: ws:// URLs on each private address, and the LAN web page a phone can open.
  async function hints() {
    refresh();
    if (!on || !ctx || addresses.length === 0) return [{ kind: 'lan', on: false, label: 'Same network' }];
    const port = ctx.listener.port();
    const key = ctx.registry.pathKey();
    if (!port || !key) return [{ kind: 'lan', on: false, label: 'Same network' }];
    return [{
      kind: 'lan',
      on: true,
      label: 'Same network',
      urls: addresses.map(c => `ws://${hostOf(c.address)}:${port}/b/${key}`),
      web: `http://${hostOf(addresses[0].address)}:${port}/p/${key}/`,
    }];
  }

  return { start, stop, status, hints };
}

const carrier = createLanCarrier();
export default carrier;
