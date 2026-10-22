import { promises as fs } from 'node:fs';
import path from 'node:path';
import { checkAccess } from './guard.mjs';
import { IMAGE_NAME, MAX_IMAGES, imageLimitMessage, imageTypeOf, loadImageFile } from './images.mjs';
import { MAX_FILES, PDF_NAME, loadDocumentFile, pdfRefusal, pdfTypeOf } from './attachments.mjs';
import { DIFF_SAFE, runGit } from './git-run.mjs';

const MAX_ATTACH = 100_000;
const MAX_DIFF = 60_000;
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '__pycache__']);

// B-39: the block of a file named with @ starts with "--- file: <name> ---" and ends with "--- end: <name> ---", and the model is
// told those lines bound the data. A line of the file that looks like the end marker would close the block early, so such lines
// are changed: the leading dashes become "- - -", and "<<END FILE" (the marker of an attached file) gets a space after its "<<".
// Ordinary lines, a dash in the middle of a line, a Markdown rule and "--- end of day" are left as they are. Look-alike characters
// (full-width letters and colons, dash characters other than the hyphen) are folded before the test, so a look-alike marker is caught.
// Pattern matching is a mitigation, not proof against every look-alike; a random token per turn would be the stronger fix.
const INVISIBLE = '\\u200B-\\u200D\\u2060\\uFEFF';
const FORGED_MARKER = new RegExp(`^[\\s${INVISIBLE}]*-{2,}[ \\t]*(?:file|end)[ \\t]*:`, 'i');
const LEADING_DASHES = new RegExp(`^([\\s${INVISIBLE}]*)[-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]+`);

// The line as a reader would see it, with the look-alikes folded to the plain characters the markers use.
function foldLine(line) {
  return line.normalize('NFKC').replace(/[‐-―−﹘﹣]/g, '-').replace(/[：﹕]/g, ':');
}

// The text of a file as it goes into a @path block, with any line that could close the block changed (see above).
export function frameFileText(text) {
  const withoutEnd = String(text).replace(/<<(?=\s*END\s+FILE)/gi, '<< ');
  return withoutEnd
    .split('\n')
    .map(line => {
      const folded = foldLine(line);
      let out = line;
      // The ASCII form was changed above; a full-width "＜＜" that folds to it is changed here.
      if (/<<\s*END\s+FILE/i.test(folded)) out = out.replace(/＜{2}/g, '<< ');
      if (FORGED_MARKER.test(folded)) out = out.replace(LEADING_DASHES, (_, lead) => `${lead}- - -`);
      return out;
    })
    .join('\n');
}

export function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
}

// Resolves @path mentions inside the project. Claude gets the file contents inline.
// The CLI agents (Muse Code, Codex) get only the path, since they can read the file themselves.
// An image (told by its first bytes: PNG, JPEG, GIF or WebP) is loaded instead of read as text, for a model that takes
// images. imageRoom is how many more images the message may hold (the page may have sent some already). A PDF (also told by
// its first bytes) is loaded the same way for a model that takes one (takesPdf: Claude through an API key), up to pdfRoom of
// them; for any other model it is refused without being read. The result is { text, attached, images, documents, refused,
// refusedDocuments }: refused holds a plain message for each image that could not be attached, refusedDocuments the same for PDFs.
export async function expandFileMentions(message, root, { inline, imageRoom = MAX_IMAGES, takesPdf = false, pdfRoom = MAX_FILES }) {
  const refs = [...new Set([...message.matchAll(/(?:^|\s)@(\S+)/g)].map(m => m[1]))].slice(0, 10);
  const attached = [];
  const blocks = [];
  const images = [];
  const documents = [];
  const refused = new Set();
  const refusedDocuments = new Set();
  // loadImageFile does the checks (credential folders, the project once links are followed, size, type). A refusal is kept
  // with its reason for the person to read.
  const takeImage = async file => {
    if (images.length >= imageRoom) {
      refused.add(imageLimitMessage());
      return;
    }
    try {
      images.push(await loadImageFile(file, root));
    } catch (err) {
      refused.add(err.message);
    }
  };
  // The same for a PDF, which only Claude through an API key takes. Any other model is refused before the file is read.
  const takeDocument = async file => {
    if (!takesPdf) {
      refusedDocuments.add(pdfRefusal(path.basename(file)));
      return;
    }
    if (documents.length >= pdfRoom) {
      refusedDocuments.add(`At most ${MAX_FILES} files can go with one message.`);
      return;
    }
    try {
      documents.push(await loadDocumentFile(file, root));
    } catch (err) {
      refusedDocuments.add(err.message);
    }
  };
  for (const rel of refs) {
    const abs = path.resolve(root, rel);
    if (!insideRoot(root, abs)) {
      // An image or a PDF named outside the project is looked at by the same checks, so it is refused with the reason and
      // not skipped without a word.
      if (IMAGE_NAME.test(rel)) {
        await takeImage(abs);
        continue;
      }
      if (PDF_NAME.test(rel)) {
        await takeDocument(abs);
        continue;
      }
      // A full absolute path the user typed is attached for Claude; the credential and system-folder guards still apply.
      if (!(path.isAbsolute(rel) && inline)) continue;
      try {
        checkAccess(abs);
      } catch (err) {
        blocks.push(`--- file: ${rel} not attached (${err.message}) ---`);
        continue;
      }
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    // B-18: a link inside the project (a junction or a symbolic link) can lead to a credential folder, and the lexical check above
    // does not follow it. The place the path really is goes through the same check as any file, before it is opened, attached or
    // read. A refusal says so in the block (with the reason, which names no path); nothing is read.
    try {
      checkAccess(await fs.realpath(abs));
    } catch (err) {
      const reason = err?.code ? 'it cannot be read' : err.message;
      if (inline) blocks.push(`--- file: ${rel} not attached (${reason}) ---`);
      continue;
    }
    if (await imageTypeOf(abs)) {
      await takeImage(abs);
      continue;
    }
    if (await pdfTypeOf(abs)) {
      await takeDocument(abs);
      continue;
    }
    attached.push(rel);
    if (!inline) continue;
    if (st.size > MAX_ATTACH) {
      blocks.push(`--- file: ${rel} skipped (${st.size} bytes; limit ${MAX_ATTACH}) ---`);
      continue;
    }
    const text = await fs.readFile(abs, 'utf8');
    if (text.includes('\u0000')) {
      blocks.push(`--- file: ${rel} skipped (binary) ---`);
      continue;
    }
    blocks.push(`--- file: ${rel} ---\n${frameFileText(text)}\n--- end: ${rel} ---`);
  }
  return { text: inline && blocks.length ? `${message}\n\n${blocks.join('\n\n')}` : message, attached, images, documents, refused: [...refused], refusedDocuments: [...refusedDocuments] };
}

// Shallow tree (3 levels) so the model knows what is in the project.
export async function listTree(root, max = 300) {
  const out = [];
  const queue = [{ dir: '', depth: 0 }];
  while (queue.length && out.length < max) {
    const { dir, depth } = queue.shift();
    const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP.has(entry.name) || out.length >= max) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        if (depth < 2) queue.push({ dir: rel, depth: depth + 1 });
      } else {
        out.push(rel);
      }
    }
  }
  return out;
}

// One git command for the advisor and @diff, through lib/git-run.mjs (repository programs off). null when git fails.
async function git(args, cwd) {
  const r = await runGit(args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return r.ok ? r.stdout : null;
}

// What changed in the working tree. Returns null when the folder is not a git repo,
// so the advisor can say its review is unverified. The diff runs with DIFF_SAFE, so no fsmonitor, external diff or textconv
// program of the repository runs, and runGit empties its filter drivers (DECISIONS item 30).
export async function workingDiff(root) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root);
  if (!inside || inside.trim() !== 'true') return null;
  const diff = (await git(['diff', ...DIFF_SAFE, 'HEAD'], root)) ?? (await git(['diff', ...DIFF_SAFE], root)) ?? '';
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], root)) ?? '';
  const parts = [];
  if (diff.trim()) parts.push(diff.trimEnd());
  if (untracked.trim()) parts.push(`New untracked files:\n${untracked.trim()}`);
  const text = parts.join('\n\n') || '(no changes in the working tree)';
  return text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n…[diff truncated]` : text;
}
