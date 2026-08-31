import {
  chmod,
  link,
  lstat,
  mkdir,
  opendir,
  readFile,
  readlink,
  realpath,
  rm,
  statfs,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  cleanup,
  copyFileAndHash,
  copyFilePrefixAndHash,
  entryMetadata,
  fingerprint,
  modeOctal,
  newId,
  pathExists,
  sameFingerprint,
  sha256File,
  sha256FilePrefix,
  toPosix,
} from './util.mjs';

const SECRET_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_ed25519',
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9])AKIA[A-Z0-9]{16}(?:[^A-Za-z0-9]|$)/,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{20,}/,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)\s*[:=]\s*[^\s"']{8,}/i,
  /(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@]+@/i,
];

export function containsSecretText(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

const MAX_SCAN_BYTES = 1024 * 1024;

export function secretPathReason(logicalPath) {
  const base = path.posix.basename(logicalPath).toLowerCase();
  if (SECRET_BASENAMES.has(base) || base.startsWith('.env.')) return 'credential-filename-policy';
  if (/\.(?:pem|p12|pfx|key)$/i.test(base)) return 'credential-file-extension-policy';
  return null;
}

export async function secretContentReason(filePath, size) {
  if (size > MAX_SCAN_BYTES) return null;
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  return containsSecretText(text)
    ? 'credential-content-policy'
    : null;
}

export function isGitVolatile(logicalPath) {
  return logicalPath.startsWith('.git/') && (
    logicalPath.endsWith('.lock') ||
    logicalPath.includes('/fsmonitor--daemon/') ||
    logicalPath.endsWith('/fsmonitor-watchman')
  );
}

export async function probeFilesystem(targetDirectory) {
  const probeRoot = path.join(targetDirectory, `.claude-replicant-probe-${newId('fs')}`);
  const findings = [];
  const capabilities = {
    caseSensitive: null,
    unicodeRoundTrip: false,
    symlink: false,
    hardlink: false,
    mode: false,
    timestamps: false,
    atomicRename: false,
    xattrs: 'unobserved-node-reference',
    acls: 'unobserved-node-reference',
    bsdFlags: 'unobserved-node-reference',
  };
  try {
    await mkdir(probeRoot, { mode: 0o700 });
    const plain = path.join(probeRoot, 'plain');
    await writeFile(plain, 'probe', { mode: 0o600 });

    const caseName = path.join(probeRoot, 'CaseProbe');
    await writeFile(caseName, 'case', { mode: 0o600 });
    capabilities.caseSensitive = !(await pathExists(path.join(probeRoot, 'caseprobe')));

    const unicodeName = 'unicodé-測試';
    const unicodePath = path.join(probeRoot, unicodeName);
    await writeFile(unicodePath, 'unicode', { mode: 0o600 });
    capabilities.unicodeRoundTrip = (await realpath(unicodePath)).endsWith(unicodeName);

    const symlinkPath = path.join(probeRoot, 'link');
    await symlink('plain', symlinkPath);
    capabilities.symlink = (await readlink(symlinkPath)) === 'plain';

    const hardlinkPath = path.join(probeRoot, 'hard');
    await link(plain, hardlinkPath);
    capabilities.hardlink = (await lstat(plain)).ino === (await lstat(hardlinkPath)).ino;

    await chmod(plain, 0o640);
    capabilities.mode = ((await lstat(plain)).mode & 0o777) === 0o640;

    const time = new Date('2020-01-02T03:04:05.000Z');
    await utimes(plain, time, time);
    capabilities.timestamps = Math.abs((await lstat(plain)).mtimeMs - time.getTime()) < 2000;

    const renameSource = path.join(probeRoot, 'rename-source');
    const renameTarget = path.join(probeRoot, 'rename-target');
    await writeFile(renameSource, 'rename', { mode: 0o600 });
    await import('node:fs/promises').then(({ rename }) => rename(renameSource, renameTarget));
    capabilities.atomicRename = await pathExists(renameTarget);
  } catch (error) {
    findings.push({ code: 'filesystem-probe-failed', message: error.message });
  } finally {
    await cleanup(probeRoot);
  }
  const fsStats = await statfs(targetDirectory).catch(() => null);
  return {
    platform: process.platform,
    filesystemType: fsStats ? String(fsStats.type) : 'unknown',
    availableBytes: fsStats ? Number(fsStats.bavail) * Number(fsStats.bsize) : null,
    capabilities,
    findings,
  };
}

export async function walkTree(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    const handle = await opendir(directory);
    const children = [];
    for await (const dirent of handle) children.push(dirent);
    children.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const dirent of children) {
      const logicalPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const absolutePath = path.join(directory, dirent.name);
      entries.push({ logicalPath: toPosix(logicalPath), absolutePath });
      if (dirent.isDirectory()) await visit(absolutePath, logicalPath);
    }
  }
  await visit(root);
  return entries;
}

export async function captureTree({
  source,
  payloadRoot,
  trackedPaths,
  maxEntries = 100_000,
  maxBytes = 5 * 1024 * 1024 * 1024,
}) {
  const candidates = await walkTree(source);
  if (candidates.length > maxEntries) {
    throw new Error(`Capture exceeds entry limit (${candidates.length} > ${maxEntries}).`);
  }

  const tracked = new Set(trackedPaths);
  const entries = [];
  const inventory = [];
  const findings = [];
  const hardlinkGroups = new Map();
  let totalBytes = 0;
  let secretExclusions = 0;
  let unstableEntries = 0;

  for (const candidate of candidates) {
    const { logicalPath, absolutePath } = candidate;
    const before = await fingerprint(absolutePath);
    const stats = await lstat(absolutePath, { bigint: true });
    const metadata = entryMetadata(stats);
    const baseRecord = {
      id: `entry-${entries.length + inventory.length + 1}`,
      logicalPath,
      filenameCodePoints: [...path.posix.basename(logicalPath)].map((char) =>
        `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`),
      normalization: path.posix.basename(logicalPath).normalize('NFC') === path.posix.basename(logicalPath)
        ? 'NFC'
        : 'non-NFC',
      metadata,
    };

    if (isGitVolatile(logicalPath)) {
      inventory.push({ ...baseRecord, decision: 'excluded', reason: 'git-volatile-lock-policy' });
      findings.push({ code: 'git-lock-present', path: logicalPath, severity: 'blocker' });
      continue;
    }

    if (stats.isFile()) {
      const pathSecret = secretPathReason(logicalPath);
      const contentSecret = pathSecret ? null : await secretContentReason(absolutePath, Number(stats.size));
      const secretReason = pathSecret ?? contentSecret;
      if (secretReason) {
        if (tracked.has(logicalPath) || logicalPath.startsWith('.git/')) {
          throw new Error(
            `Known credential material is tracked or part of Git state at ${logicalPath}; ` +
            'Part 1 refuses capture until it is removed and Git history/state is reviewed.',
          );
        }
        secretExclusions += 1;
        inventory.push({
          ...baseRecord,
          metadata: undefined,
          decision: 'excluded',
          reason: secretReason,
          sensitivity: 'credential',
        });
        findings.push({
          code: 'credential-excluded',
          path: logicalPath,
          severity: 'action-required',
        });
        continue;
      }

      totalBytes += Number(stats.size);
      if (totalBytes > maxBytes) throw new Error(`Capture exceeds byte limit (${maxBytes}).`);
      const destination = path.join(payloadRoot, ...logicalPath.split('/'));
      const appendOnlyCandidate = logicalPath.startsWith('.claude/') && logicalPath.endsWith('.jsonl');
      const capturedLength = Number(stats.size);
      const digest = appendOnlyCandidate
        ? await copyFilePrefixAndHash(absolutePath, destination, capturedLength)
        : await copyFileAndHash(absolutePath, destination);
      const groupKey = stats.nlink > 1n ? `${stats.dev}:${stats.ino}` : null;
      let hardlinkGroup = null;
      if (groupKey) {
        hardlinkGroup = hardlinkGroups.get(groupKey) ?? `hardlink-${hardlinkGroups.size + 1}`;
        hardlinkGroups.set(groupKey, hardlinkGroup);
      }
      const after = await fingerprint(absolutePath);
      let stable = sameFingerprint(before, after);
      let liveAppend = false;
      if (
        appendOnlyCandidate &&
        before.inode === after.inode &&
        BigInt(after.size) >= BigInt(before.size) &&
        digest === await sha256FilePrefix(absolutePath, capturedLength)
      ) {
        stable = true;
        liveAppend = BigInt(after.size) > BigInt(before.size);
        if (liveAppend) {
          findings.push({
            code: 'live-append-stable-prefix',
            path: logicalPath,
            capturedBytes: capturedLength,
            observedEndBytes: Number(after.size),
            severity: 'action-required',
          });
        }
      }
      if (!stable) {
        unstableEntries += 1;
        findings.push({ code: 'source-changed-during-capture', path: logicalPath, severity: 'blocker' });
      }
      const record = {
        ...baseRecord,
        kind: 'file',
        sha256: digest,
        payloadPath: `payload/repository/${logicalPath}`,
        hardlinkGroup,
        capturedLength,
        liveAppend,
        stable,
      };
      entries.push(record);
      inventory.push({ ...record, decision: 'included', reason: 'selected-project-scope' });
      continue;
    }

    if (stats.isDirectory()) {
      const destination = path.join(payloadRoot, ...logicalPath.split('/'));
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const record = {
        ...baseRecord,
        kind: 'directory',
        sha256: null,
        payloadPath: `payload/repository/${logicalPath}`,
        stable: true,
      };
      entries.push(record);
      inventory.push({ ...record, decision: 'included', reason: 'selected-project-scope' });
      continue;
    }

    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      if (containsSecretText(target)) {
        secretExclusions += 1;
        inventory.push({
          ...baseRecord,
          metadata: undefined,
          decision: 'excluded',
          reason: 'credential-symlink-target-policy',
          sensitivity: 'credential',
        });
        findings.push({
          code: 'credential-excluded',
          path: logicalPath,
          severity: 'action-required',
        });
        continue;
      }
      const destination = path.join(payloadRoot, ...logicalPath.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await symlink(target, destination);
      const targetClass = path.isAbsolute(target)
        ? 'absolute'
        : path.resolve(path.dirname(absolutePath), target).startsWith(`${source}${path.sep}`)
          ? 'relative-in-scope'
          : 'relative-out-of-scope';
      if (targetClass !== 'relative-in-scope') {
        findings.push({ code: 'symlink-portability-risk', path: logicalPath, targetClass, severity: 'action-required' });
      }
      const record = {
        ...baseRecord,
        kind: 'symlink',
        sha256: null,
        payloadPath: `payload/repository/${logicalPath}`,
        linkTarget: target,
        targetClass,
        stable: true,
      };
      entries.push(record);
      inventory.push({ ...record, decision: 'included', reason: 'selected-project-scope' });
      continue;
    }

    inventory.push({ ...baseRecord, decision: 'metadata-only', reason: 'unsupported-special-file' });
    findings.push({ code: 'special-file-not-captured', path: logicalPath, severity: 'action-required' });
  }

  return {
    entries,
    inventory,
    findings,
    totals: { entries: entries.length, bytes: totalBytes, secretExclusions, unstableEntries },
  };
}

export async function applyFileMetadata(filePath, entry, variances) {
  if (!entry.metadata) return;
  try {
    await chmod(filePath, entry.metadata.mode);
  } catch (error) {
    variances.push({ code: 'metadata-variance:mode-not-applied', path: entry.logicalPath, message: error.message });
  }
  try {
    const atime = Number(BigInt(entry.metadata.atimeNs) / 1_000_000n) / 1000;
    const mtime = Number(BigInt(entry.metadata.mtimeNs) / 1_000_000n) / 1000;
    await utimes(filePath, atime, mtime);
  } catch (error) {
    variances.push({ code: 'metadata-variance:timestamps-not-applied', path: entry.logicalPath, message: error.message });
  }
}

export async function verifyTree(root, entries) {
  const errors = [];
  for (const entry of entries) {
    const target = path.join(root, ...entry.logicalPath.split('/'));
    const stats = await lstat(target).catch(() => null);
    if (!stats) {
      errors.push({ code: 'missing-entry', path: entry.logicalPath });
      continue;
    }
    if (entry.kind === 'file') {
      if (!stats.isFile()) errors.push({ code: 'kind-mismatch', path: entry.logicalPath });
      else if ((await sha256File(target)) !== entry.sha256) {
        errors.push({ code: 'hash-mismatch', path: entry.logicalPath });
      }
    } else if (entry.kind === 'directory' && !stats.isDirectory()) {
      errors.push({ code: 'kind-mismatch', path: entry.logicalPath });
    } else if (entry.kind === 'symlink') {
      if (!stats.isSymbolicLink()) errors.push({ code: 'kind-mismatch', path: entry.logicalPath });
      else if ((await readlink(target)) !== entry.linkTarget) {
        errors.push({ code: 'symlink-target-mismatch', path: entry.logicalPath });
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function removeIfExists(filePath) {
  if (await pathExists(filePath)) await rm(filePath, { recursive: true, force: true });
}
