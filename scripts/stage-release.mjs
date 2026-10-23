#!/usr/bin/env node
// Staged rollout of a Plenum release. Run it with the tag and a percentage:
//
//   node scripts/stage-release.mjs v0.6.0 10     offer the update to about one install in ten
//   node scripts/stage-release.mjs v0.6.0 50     widen it
//   node scripts/stage-release.mjs v0.6.0 100    everyone (the stagingPercentage line is removed)
//   node scripts/stage-release.mjs v0.6.0 0      nobody: the update is held
//
// The percentage is a whole number from 0 to 100. The repository is read from package.json (build.publish). The GitHub
// CLI (gh) does the work: it downloads the tag's .yml assets, the line is set in each, and each is uploaded again with
// --clobber. It works on a draft and on a published release, so a rollout can be widened after publishing.
//
// How electron-updater reads it. The update feed files (latest.yml, latest-mac.yml, latest-linux.yml, beta*.yml,
// alpha*.yml) carry the top-level key stagingPercentage. Each install keeps a random ID in its user-data folder (the
// file .updaterId) and turns it into a number between 0 and 1. The install takes the update only when that number is
// below the percentage. So 0 offers the update to nobody, and a missing line offers it to everybody. Note that 0 keeps
// the line: removing it would offer the update to everybody.
//
// Pulling a bad release is not a rollout step. An installed app that has taken a version does not go back, so publish a
// higher version with the fix, and stage that one.
//
// Exit status: 0 when every feed file was updated; 1 with a plain message otherwise. Files already uploaded before a
// failure keep their new value; running the same command again sets every file to the requested value.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const PERCENT_PATTERN = /^\d{1,3}$/;
const STAGING_LINE = /^stagingPercentage:/;

export class StageError extends Error {}

// Returns the percentage as a number, or null when the text is not a whole number from 0 to 100.
export function parsePercent(text) {
  if (typeof text !== 'string' || !PERCENT_PATTERN.test(text)) return null;
  const value = Number(text);
  return value <= 100 ? value : null;
}

// Sets (or removes) the top-level stagingPercentage line of one feed file. 100 removes it. Returns the new text and the
// value that was there before (null when there was no line).
export function setStagingLine(text, percent) {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let previous = null;
  let placed = false;
  for (const line of lines) {
    if (STAGING_LINE.test(line)) {
      previous = line.slice('stagingPercentage:'.length).trim();
      if (!placed && percent < 100) out.push(`stagingPercentage: ${percent}`);
      placed = true;
      continue;
    }
    out.push(line);
  }
  if (!placed && percent < 100) out.push(`stagingPercentage: ${percent}`);
  return { text: `${out.join('\n')}\n`, previous };
}

// The repository named in package.json build.publish, as "owner/repo".
export function readRepository(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const publish = pkg.build?.publish ?? {};
  const owner = typeof publish.owner === 'string' ? publish.owner : '';
  const repo = typeof publish.repo === 'string' ? publish.repo : '';
  if (owner === '' || owner.includes('[') || !REPO_PART.test(owner)) {
    throw new StageError('Set build.publish.owner in package.json to the GitHub account that owns the release repository.');
  }
  if (repo === '' || repo.includes('[') || !REPO_PART.test(repo)) {
    throw new StageError('Set build.publish.repo in package.json to the name of the release repository.');
  }
  return `${owner}/${repo}`;
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

// Runs gh with execFile (no shell), so a tag or a path cannot become shell syntax.
function runGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr ?? '');
        reject(error);
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

function describe(previous, percent) {
  if (percent === 100) return previous === null ? 'no line (everybody)' : `removed the line (was ${previous}; now everybody)`;
  if (percent === 0) return `stagingPercentage: 0 (nobody is offered it${previous === null ? '' : `; was ${previous}`})`;
  return previous === null ? `stagingPercentage: ${percent} (added)` : `stagingPercentage: ${previous} -> ${percent}`;
}

export async function stageRelease(tag, percent, { root = ROOT, gh = runGh, log = console.log } = {}) {
  const repo = readRepository(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-stage-'));
  try {
    try {
      await gh(['release', 'download', tag, '--repo', repo, '--pattern', '*.yml', '--dir', dir]);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new StageError('The GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and sign in with gh auth login.');
      }
      if (!/no assets match/i.test(String(error.stderr ?? ''))) {
        throw new StageError(`gh could not download the release files for ${tag} from ${repo}: ${firstLine(error.stderr) || error.message}`);
      }
      // No matching asset: the check below reports it.
    }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.yml')).sort();
    if (files.length === 0) {
      throw new StageError(`The release ${tag} on ${repo} has no update feed files (*.yml). Let the release workflow finish first, then run this again.`);
    }
    for (const name of files) {
      const full = path.join(dir, name);
      const { text, previous } = setStagingLine(fs.readFileSync(full, 'utf8'), percent);
      fs.writeFileSync(full, text, 'utf8');
      try {
        await gh(['release', 'upload', tag, full, '--clobber', '--repo', repo]);
      } catch (error) {
        throw new StageError(`gh could not upload ${name} to ${tag}: ${firstLine(error.stderr) || error.message}. Files before it were changed; run the command again to set them all.`);
      }
      log(`${name}: ${describe(previous, percent)}, uploaded to ${tag} on ${repo}`);
    }
    return files.length;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv.length !== 2) {
    throw new StageError('Usage: node scripts/stage-release.mjs <tag> <percent>   (for example: node scripts/stage-release.mjs v0.6.0 10)');
  }
  const [tag, percentText] = argv;
  if (!TAG_PATTERN.test(tag)) {
    throw new StageError(`The tag must look like v0.6.0 or v0.6.0-beta.1, not "${tag}".`);
  }
  const percent = parsePercent(percentText);
  if (percent === null) {
    throw new StageError('The percent must be a whole number from 0 to 100.');
  }
  await stageRelease(tag, percent);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof StageError) {
      console.error(error.message);
    } else {
      console.error(`The rollout failed: ${error.message}`);
    }
    process.exitCode = 1;
  });
}
