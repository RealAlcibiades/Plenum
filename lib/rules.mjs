// Project instructions from AGENTS.md in the project root. Chat turns read it, so an edit shows up on the next message.
// A file whose real path is outside the project is refused. That covers a link that points elsewhere on disk.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RULES_FILE = 'AGENTS.md';
// Long enough for a real guide, short enough that it does not crowd out the conversation.
const MAX_CHARS = 32000;
// A UTF-8 character takes at most 3 bytes per UTF-16 unit, so this many bytes always holds MAX_CHARS characters.
// The 4 extra bytes cover a character cut at the end of the read.
const MAX_READ_BYTES = MAX_CHARS * 3 + 4;

// True when target is inside root. The root itself does not count, and neither does a path that climbs out of it.
function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Reads the first `count` bytes of a file and no more, so a very long file is never loaded whole.
async function readHead(file, count) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buf, 0, count, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

// Returns { text, bytes } for the project's AGENTS.md, or null when there is no usable file.
// text is capped at 32,000 characters. bytes is the file size on disk, before the cap.
export async function loadProjectRules(projectPath) {
  let root;
  let real;
  try {
    root = await fs.realpath(projectPath);
    real = await fs.realpath(path.join(root, RULES_FILE));
  } catch {
    // No project folder, or no AGENTS.md in it.
    return null;
  }
  // Refused: the file, or a link to it, resolves outside the project folder.
  if (!insideRoot(root, real)) return null;
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return null;
    // A file over the read limit is read only up to it. The cap below then trims the text to MAX_CHARS.
    const raw = (await readHead(real, Math.min(stat.size, MAX_READ_BYTES))).replace(/^﻿/, '');
    // An empty file has nothing to tell the model, so it counts as no file.
    if (!raw.trim()) return null;
    let text = raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
    // Do not leave half of a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { text, bytes: stat.size };
  } catch {
    // Unreadable, such as a folder named AGENTS.md. The chat goes on without it.
    return null;
  }
}
