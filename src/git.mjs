import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { digestObject, pathExists, sha256File } from './util.mjs';

const execFileAsync = promisify(execFile);
const MIN_GIT = [2, 39, 0];

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseGitVersion(output) {
  const match = output.trim().match(/^git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Unable to parse Git version: ${output.trim()}`);
  return { raw: output.trim(), tuple: match.slice(1).map(Number) };
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

const SAFE_PREFIX = [
  '--no-optional-locks',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'credential.helper=',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'protocol.file.allow=never',
];

export async function runGit(gitPath, repository, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(gitPath, [...SAFE_PREFIX, ...args], {
      cwd: repository,
      env: gitEnvironment(),
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: typeof error.stderr === 'string' ? error.stderr : '',
        code: error.code,
      };
    }
    throw new Error(`Safe Git command failed (${args.join(' ')}): ${error.stderr || error.message}`);
  }
}

export async function probeGit(gitPath = 'git') {
  const resolvedPath = gitPath.includes(path.sep)
    ? path.resolve(gitPath)
    : (await execFileAsync('/usr/bin/which', [gitPath], {
      env: gitEnvironment(),
      encoding: 'utf8',
      timeout: 5_000,
    }).catch((error) => {
      throw new Error(`Git is required (>=2.39.0 <3.0.0): ${error.message}`);
    })).stdout.trim();
  const result = await execFileAsync(resolvedPath, ['--version'], {
    env: gitEnvironment(),
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  }).catch((error) => {
    throw new Error(`Git is required (>=2.39.0 <3.0.0): ${error.message}`);
  });
  const version = parseGitVersion(result.stdout);
  if (compareVersion(version.tuple, MIN_GIT) < 0 || version.tuple[0] >= 3) {
    throw new Error(`Unsupported ${version.raw}; Part 1 requires Git >=2.39.0 <3.0.0.`);
  }
  return { path: resolvedPath, version: version.raw };
}

function parseConfigPathBindings(text) {
  const bindings = [];
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    const assignment = line.match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const key = `${section}.${assignment[1].toLowerCase()}`;
    if (key === 'core.worktree') bindings.push({ kind: 'core.worktree', value: '<redacted-path>' });
    if (key === 'core.excludesfile') bindings.push({ kind: 'core.excludesFile', value: '<redacted-path>' });
    if (key === 'core.attributesfile') bindings.push({ kind: 'core.attributesFile', value: '<redacted-path>' });
    if (section === 'include' && assignment[1].toLowerCase() === 'path') {
      bindings.push({ kind: 'include.path', value: '<redacted-path>' });
    }
    if (section.startsWith('includeif ') && assignment[1].toLowerCase() === 'path') {
      bindings.push({ kind: 'includeIf.path', value: '<redacted-path>' });
    }
  }
  return bindings;
}

export async function inspectGitLayout(repository) {
  const dotGit = path.join(repository, '.git');
  const info = await lstat(dotGit).catch(() => null);
  if (!info) throw new Error(`Selected source is not a Git repository: ${repository}`);
  const bindings = [];
  if (info.isFile()) bindings.push({ kind: 'gitdir-file', value: '<path-bound>' });
  if (!info.isDirectory() && !info.isFile()) {
    bindings.push({ kind: 'unsupported-dot-git-kind', value: info.mode });
  }
  if (info.isDirectory()) {
    if (await pathExists(path.join(dotGit, 'commondir'))) {
      bindings.push({ kind: 'commondir', value: '<path-bound>' });
    }
    if (await pathExists(path.join(dotGit, 'objects', 'info', 'alternates'))) {
      bindings.push({ kind: 'object-alternates', value: '<external-object-path>' });
    }
    const configPath = path.join(dotGit, 'config');
    if (await pathExists(configPath)) {
      bindings.push(...parseConfigPathBindings(await readFile(configPath, 'utf8')));
    }
  }
  return {
    layout: info.isDirectory() ? 'dot-git-directory' : info.isFile() ? 'gitdir-file' : 'unsupported',
    pathBound: bindings,
    actualRestoreSupported: info.isDirectory() && bindings.length === 0,
  };
}

function normalizeLines(text) {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

export async function captureGitSnapshot(repository, git) {
  const [head, symbolic, refs, status, indexEntries, tracked] = await Promise.all([
    runGit(git.path, repository, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }),
    runGit(git.path, repository, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }),
    runGit(git.path, repository, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
    runGit(git.path, repository, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '--ignored=matching',
    ]),
    runGit(git.path, repository, ['ls-files', '--stage']),
    runGit(git.path, repository, ['ls-files', '-z']),
  ]);

  const indexPath = path.join(repository, '.git', 'index');
  const indexDigest = (await pathExists(indexPath)) ? await sha256File(indexPath) : null;
  const snapshot = {
    head: head.ok ? head.stdout.trim() : null,
    symbolicHead: symbolic.ok ? symbolic.stdout.trim() : null,
    refs: normalizeLines(refs.stdout),
    status: normalizeLines(status.stdout),
    indexEntries: normalizeLines(indexEntries.stdout),
    indexDigest,
  };
  return {
    ...snapshot,
    trackedPaths: tracked.stdout.split('\0').filter(Boolean),
    snapshotDigest: digestObject(snapshot),
  };
}

export function comparableGitSnapshot(snapshot) {
  const clone = structuredClone(snapshot);
  delete clone.trackedPaths;
  return clone;
}
