# Noise test vectors

These files are published test vectors from two independent Noise implementations. They are used by `mobile/test/noise.test.mjs` to prove that `lib/remote/noise.mjs` produces the same bytes as the reference implementations for the two suites Plenum uses:

- `Noise_IK_25519_ChaChaPoly_SHA256` (known phones)
- `Noise_IKpsk2_25519_ChaChaPoly_SHA256` (pairing)

Only those two suites were kept. Every other vector in the source files (other patterns, ciphers, hashes and curves) was left out on purpose. The vector objects are copied unmodified; each file wraps them in `{ "source": { ... }, "vectors": [ ... ] }` so the attribution travels with the data.

## Files

| File | Source | Entries kept | Licence |
| --- | --- | --- | --- |
| `cacophony-ik-ikpsk2-25519-chachapoly-sha256.json` | cacophony, `vectors/cacophony.txt` | `Noise_IK_...`, `Noise_IKpsk2_...` | Unlicense (public domain) |
| `noise-c-ik-25519-chachapoly-sha256.json` | noise-c, `tests/vector/noise-c-basic.txt` | `Noise_IK_...` (noise-c's basic set has no IKpsk2 entry) | MIT |

### cacophony

- Project: cacophony, a Haskell implementation of the Noise Protocol Framework
- Repository: https://github.com/centromere/cacophony
- File: `vectors/cacophony.txt`, last commit touching it `18b7348c54fd61fcd0c220298883de0d09c8364d` (2018-12-16)
- Retrieved: 2026-10-22 from `https://raw.githubusercontent.com/centromere/cacophony/master/vectors/cacophony.txt` (1,709,817 bytes, sha256 `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`)
- Licence: the repository's `LICENSE` is the Unlicense (public domain dedication, http://unlicense.org). No notice is required to copy it; the attribution here is a courtesy and a provenance record.

### noise-c

- Project: noise-c, the C reference implementation of the Noise Protocol Framework by Southern Storm Software
- Repository: https://github.com/rweather/noise-c
- File: `tests/vector/noise-c-basic.txt`, last commit touching it `5d0a74760320e5486ced302e36ccad91606aac43` (2016-05-17)
- Retrieved: 2026-10-22 from `https://raw.githubusercontent.com/rweather/noise-c/master/tests/vector/noise-c-basic.txt` (897,794 bytes, sha256 `e826749cf90efda26be85410381f4b1f75552c61c7c0dcad7f9ffb4d639e4e45`)
- Licence: MIT. The licence text below must accompany copies of the vectors.

```
Copyright (C) 2016 Southern Storm Software, Pty Ltd.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## Format

Each vector is one complete handshake followed by transport messages, with fixed ephemeral keys so the bytes are reproducible.

| Field | Meaning |
| --- | --- |
| `name` / `protocol_name` | The full Noise protocol name |
| `init_prologue`, `resp_prologue` | Prologue bytes, hex |
| `init_psks`, `resp_psks` | Pre-shared keys, hex (IKpsk2 only) |
| `init_static`, `resp_static` | Static X25519 private keys, hex |
| `init_ephemeral`, `resp_ephemeral` | Ephemeral X25519 private keys, hex |
| `init_remote_static` | The responder's static public key, hex (the IK pre-message) |
| `handshake_hash` | Final handshake hash h, hex (cacophony vectors only) |
| `messages[n].payload`, `.ciphertext` | Plaintext and expected wire bytes, hex. Message 0 is the initiator's handshake message, message 1 the responder's, messages 2 and later are transport messages that alternate initiator, responder, initiator, ... |

The test feeds the fixed ephemeral keys to the handshake through its injectable `random` option and compares every ciphertext, the final handshake hash and every transport message byte for byte, in both directions.

## Refreshing

Download the source file again, copy the entries whose name is exactly one of the two suites above into a new wrapper, update the commit, date and sha256 above, and run `node --test mobile/test/noise.test.mjs`. Do not hand-edit vector values.
