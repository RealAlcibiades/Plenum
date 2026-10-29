# Plenum relay

The relay lets a phone reach Plenum on your computer when the two are not on the same network. It is one Cloudflare Worker and one Durable Object class, `Room`, that forwards opaque frames between your computer and your phones. You deploy it to your own Cloudflare account. The owner of Plenum runs no relay.

Everything between a phone and your computer is encrypted end to end with Noise. The relay never sees message content. It sees IP addresses, timing, message sizes and counts, room ids, a hash of the host secret, and the shell files it serves.

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RealAlcibiades/Plenum/tree/main/relay)

1. You need a free Cloudflare account and a free GitHub account. The button clones this folder into your GitHub and deploys it with Workers Builds.
2. Copy the Worker URL, for example `https://plenum-relay.<your-account>.workers.dev`.
3. In Plenum, open Settings > Phones > Relay and paste the URL into the Relay field. Plenum fetches `/version.json`, makes a room id and a host secret, connects as the host and shows "Relay connected".
4. Phones install the Plenum web app from that same URL and pair with the QR code.

The Deploy button makes your own copy of this folder, not a fork, so later fixes to the relay and the phone shell do not reach it by themselves. To update, copy the newer `relay/` folder from Plenum's repository into your copy and redeploy from the Cloudflare dashboard. Every deploy disconnects every socket, so phones reconnect on their own.

## What runs where

| Path | What it does |
| --- | --- |
| `src/index.mjs` | The Worker: routes, the host secret check (it hashes the secret and passes only the hash on), the shell and its Content-Security-Policy header. |
| `src/room.mjs` | The `Room` Durable Object: claims the room, forwards frames, enforces the limits, deletes idle rooms. |
| `src/limits.mjs` | The limits and close codes, in one place. |
| `public/` | The shell the Worker serves. `index.html`, `sw.js` and `version.json` here are placeholders; the Plenum build replaces them. |
| `wrangler.jsonc` | The configuration the Deploy button uses. It has no secrets and no account settings. |
| `LICENSE-RELAY.txt` | The grant that lets you deploy and run these files for use with Plenum. |

### Routes

| Request | Answer |
| --- | --- |
| `GET /room/<id>` with `Upgrade: websocket` | Forwarded to the room. Refused with 403 for a wrong host secret. |
| `GET /room/<id>` without an upgrade | 426 Upgrade Required |
| `GET /` | The shell, with `Content-Security-Policy: default-src 'self'; connect-src 'self' wss:; img-src 'self' data:` and no inline script or style |
| `GET /version.json`, `/sw.js`, `/manifest.webmanifest`, `/assets/*` | The shell files, with the same headers |
| anything else | 404 |

Room ids are 32 lowercase hex characters (128 random bits), chosen by your computer. The host secret is 22 to 128 characters of `A-Za-z0-9_-`, sent in the `x-plenum-host-secret` header. The first host to connect claims the room and the relay stores only the SHA-256 of that secret. Later hosts must present the same secret. A host with a different secret gets 403.

### The wire

Binary frames. Every frame from the host starts with a 4-byte big-endian connection id that the room assigns to each phone.

- Phone to host: the room sends `[conn][frame]`. The host knows which phone sent it.
- Host to phone: the host sends `[conn][frame]`. The room removes the id and sends `[frame]`, so the phone sees a plain frame.
- Connection id 0 is control. From the host to the room: `{"op":"rotate","secretHash":"<64 hex>"}` replaces the stored host secret hash, and `{"op":"kick","conn":<id>}` closes one phone. From the room to the host: `{"op":"open","conn":<id>,"ip":"<address>"}` when a phone joins and the Worker passed its `cf-connecting-ip` (sent before the phone's first frame, and not at all when there is no address), so your computer limits handshakes per phone address instead of for all relay phones together; and `{"op":"closed","conn":<id>}` when a phone's socket has gone, and when this room closes a phone itself for a limit (a text frame, a frame over 65536 bytes, or the rate limit), just before it closes that socket. A phone the computer kicks is not reported. Unknown or malformed control is ignored.
- A text frame `ping` gets `pong` from the runtime without waking the room. Any other text frame closes the sender with 1003.

### Limits

| Limit | Value | Close |
| --- | --- | --- |
| Frame size | a phone frame up to 65536 bytes; the host sees at most 65540 with the id | 1009 `frame-too-big` |
| Phones per room | 8; the ninth is accepted and then closed | 1008 `room-full` |
| Messages per second, per phone | 200 | 1008 `rate-limit` |
| Phone bytes per second, per phone connection | 2 MiB (2,097,152 bytes) | 1008 `rate-limit`, for that connection only |
| Idle room | deleted by an alarm 30 days after the last connect or disconnect, when no socket is open | none; the room's data is deleted except the stored host secret hash, so nobody else can claim the room |

The two rate caps count phone frames only. A phone that uploads faster than 2 MiB a second is disconnected, so uploads must be paced below that rate. The phone client paces its uploads under that limit (1.5 MiB/s, relay sessions only), so a large attachment (over about 2 MB) no longer disconnects the phone; a 32 MB attachment takes about 22 s. Other phones in the room are not affected. Host frames are not capped here: the desktop paces them, and a cap would cut off shell and stream transfers.

Close codes the phone and the desktop see:

| Code | Reason | Meaning |
| --- | --- | --- |
| 4001 | `host-offline` | No host is connected, or the host went away. Also the reason a phone is refused while the computer sleeps. |
| 4002 | `kicked` | The host removed this phone. |
| 4003 | `host-replaced` | A newer host with the same secret connected. This closes the older host. |
| 4004 | `host-reset` | A new host connected. Phones reconnect and start a fresh Noise session. |

### If the relay turns your computer away

If Settings › Phones says your relay turned this computer away, someone else holds this room. Click New room there: this computer moves to a fresh room, and phones paired before reach it through the relay again after you pair them again. Remove all also moves to a new room. New room is also the recovery when a room URL leaks: this computer leaves the old room for good, so the old address no longer reaches it.

### Free plan arithmetic

Figures from Cloudflare's pricing and limits pages as read when this README was written (2026-10-22). Check them before you rely on them.

- Free: Durable Objects 100,000 requests a day, 13,000 GB-seconds a day, 5 GB stored. Workers 100,000 requests a day. A limit that is exceeded fails until 00:00 UTC.
- A WebSocket connection (the upgrade) is one request. Each incoming message is billed 20:1, so 100 messages count as 5 requests. Outgoing messages are free. The runtime's ping and pong are not billed and do not wake the room.
- Every frame either side sends is one incoming message to the room. A session with 10 frames a second in total, for an hour, is 36,000 messages, or 1,800 requests. The 100,000 daily requests then cover about 55 hours of such traffic a day.
- The room hibernates between frames, so idle time is not billed as duration.
- The relay writes storage only on connect and disconnect, so the rows-written allowance is not used by traffic.

## Logs and privacy

Workers logs are off (`observability.enabled` is false) and the code never logs. The relay never writes a payload. It stores the room's host secret hash, the time of the last connect or disconnect, and the alarm.

## Running the tests

```
cd relay
npm ci
npm test           # node --test "test/*.test.mjs"
npm run dry-run    # wrangler deploy --dry-run; needs no Cloudflare account
```

- `test/room.test.mjs` runs the relay under miniflare, which is workerd on your machine, on 127.0.0.1 and random ports. CI runs it on Linux, where it is mandatory. On Windows it is skipped with a reason, because the pinned workerd exits at startup on the build machine; set `RELAY_REQUIRE_MINIFLARE=1` to run it there and fail if workerd does not start.
- `test/room-logic.test.mjs` runs the same scenarios in-process against the same Worker and `Room` class, with a stand-in for the Cloudflare runtime. It runs on any machine with Node 22 or newer.
- `test/worker.test.mjs` checks the pins, the Wrangler config, the licence grant, the shell's CSP rules, the no-logging rule and the limits.

The tests never reach Cloudflare, a push service or any address other than 127.0.0.1.

## Licence

`LICENSE-RELAY.txt`: you may deploy unmodified copies of this folder to your own Cloudflare account and run them for use with Plenum. All other rights are reserved.
