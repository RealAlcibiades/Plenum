// Limits and close codes of the relay. Plain constants, no runtime imports, so the
// tests can read them without the Workers runtime.
export const LIMITS = Object.freeze({
  maxPhonesPerRoom: 8,
  // Any binary frame on any socket. Host frames carry the 4-byte connection id,
  // so the largest frame the phone ever sees is 65536 bytes.
  maxWireFrameBytes: 65540,
  // A phone frame gains the 4-byte connection id on its way to the host, so it
  // is capped at 65536 bytes and the host still sees at most 65540.
  maxPhoneFrameBytes: 65536,
  phoneMessagesPerSecond: 200, // per phone connection
  phoneBytesPerSecond: 2 * 1024 * 1024, // per phone connection
  idleMs: 30 * 24 * 60 * 60 * 1000,
});

// Close codes. 4000 to 4999 are free for applications; the reason text is the
// name the phone and the desktop compare against.
export const CLOSE = Object.freeze({
  unsupported: 1003, // reason 'binary-only'
  policy: 1008, // reasons 'room-full' and 'rate-limit'
  tooBig: 1009, // reason 'frame-too-big'
  hostOffline: 4001, // reason 'host-offline'
  kicked: 4002, // reason 'kicked' (host control op kick)
  hostReplaced: 4003, // reason 'host-replaced' (an older host socket)
  hostReset: 4004, // reason 'host-reset' (phones when a new host takes over)
});
