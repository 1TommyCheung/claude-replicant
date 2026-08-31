import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const FORMAT_VERSION = '1.0.0';
export const RESTORE_PLAN_SCHEMA = 'claude-replicant.restore-plan/v1';
export const NODE_RANGE = '>=22.0.0 <23.0.0';
export const GIT_RANGE = '>=2.39.0 <3.0.0';

export function assertNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major !== 22) {
    throw new Error(
      `Unsupported Node.js ${process.versions.node}. Part 1 requires ${NODE_RANGE}.`,
    );
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function writeJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export async function writeJsonAtomic(filePath, value, mode = 0o600) {
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeJson(temp, value, mode);
  await rename(temp, filePath);
}

export async function writeTextAtomic(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, value, { mode });
  await rename(temp, filePath);
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export function fromPosix(relativePath) {
  return relativePath.split('/').join(path.sep);
}

export function assertSafeLogicalPath(logicalPath) {
  if (
    typeof logicalPath !== 'string' ||
    logicalPath.length === 0 ||
    logicalPath.includes('\0') ||
    path.posix.isAbsolute(logicalPath) ||
    logicalPath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe logical path: ${JSON.stringify(logicalPath)}`);
  }
}

export function safeJoin(root, logicalPath) {
  assertSafeLogicalPath(logicalPath);
  const candidate = path.resolve(root, fromPosix(logicalPath));
  const resolvedRoot = path.resolve(root);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes root: ${logicalPath}`);
  }
  return candidate;
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(filePath, label) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${label} must be an existing directory: ${filePath}`);
}

export async function resolveExistingDirectory(filePath, label) {
  await ensureDirectory(filePath, label);
  return realpath(filePath);
}

export function pathsOverlap(first, second) {
  const a = path.resolve(first);
  const b = path.resolve(second);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export function entryMetadata(stats) {
  return {
    mode: Number(stats.mode & 0o0777n),
    sourceSpecialMode: Number(stats.mode & 0o7000n),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    size: Number(stats.size),
    nlink: Number(stats.nlink),
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    atimeNs: stats.atimeNs.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  };
}

export async function fingerprint(filePath) {
  const stats = await lstat(filePath, { bigint: true });
  return {
    kind: stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'directory'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other',
    size: stats.size.toString(),
    inode: stats.ino.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

export function sameFingerprint(first, second) {
  return stableStringify(first) === stableStringify(second);
}

export async function copyFileAndHash(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  return sha256File(destination);
}

export async function copyFilePrefixAndHash(source, destination, length) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const sourceHandle = await open(source, 'r');
  const destinationHandle = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let position = 0;
  try {
    while (position < length) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, length - position));
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error(`Source truncated while reading stable prefix: ${source}`);
      const chunk = buffer.subarray(0, bytesRead);
      await destinationHandle.write(chunk, 0, chunk.length, position);
      hash.update(chunk);
      position += bytesRead;
    }
    await destinationHandle.sync();
  } finally {
    await sourceHandle.close();
    await destinationHandle.close();
  }
  return hash.digest('hex');
}

export async function sha256FilePrefix(filePath, length) {
  const handle = await open(filePath, 'r');
  const hash = createHash('sha256');
  let position = 0;
  try {
    while (position < length) {
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, length - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function fsyncFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function cleanup(filePath) {
  await rm(filePath, { recursive: true, force: true });
}

export function newId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID()}`;
}

export function withoutKey(value, key) {
  const clone = structuredClone(value);
  delete clone[key];
  return clone;
}

export function digestObject(value, omittedKey) {
  const selected = omittedKey ? withoutKey(value, omittedKey) : value;
  const persistedShape = JSON.parse(JSON.stringify(selected));
  return sha256Text(stableStringify(persistedShape));
}

export function modeOctal(mode) {
  return `0${Number(mode).toString(8)}`;
}

export function isoNow() {
  return new Date().toISOString();
}
