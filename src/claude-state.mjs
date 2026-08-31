import { open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureTree, secretPathReason, walkTree } from './filesystem.mjs';
import { pathExists, resolveExistingDirectory } from './util.mjs';

const GLOBAL_DIRECTORIES = new Set([
  'agents',
  'commands',
  'hooks',
  'memory',
  'output-styles',
  'plans',
  'plugins',
  'skills',
]);

const SESSION_DIRECTORIES = new Set([
  'file-history',
  'session-env',
  'shell-snapshots',
  'tasks',
  'todos',
]);

function encodeProjectPath(projectPath) {
  return path.resolve(projectPath).replaceAll(path.sep, '-');
}

function equivalentMacPaths(projectPath) {
  const resolved = path.resolve(projectPath);
  return resolved.startsWith('/private/')
    ? [resolved, resolved.slice('/private'.length)]
    : [resolved, `/private${resolved}`];
}

async function fileMentionsProject(filePath, source) {
  const handle = await open(filePath, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.includes(JSON.stringify(source)) || text.includes(`"cwd":"${source}"`);
  } finally {
    await handle.close();
  }
}

async function locateProjectDirectory(claudeHome, source) {
  const projectsRoot = path.join(claudeHome, 'projects');
  if (!(await pathExists(projectsRoot))) return null;
  for (const sourceVariant of equivalentMacPaths(source)) {
    const encoded = encodeProjectPath(sourceVariant);
    const exact = path.join(projectsRoot, encoded);
    if (await pathExists(exact)) return { key: encoded, path: exact, method: 'encoded-project-path' };
  }

  for (const dirent of await readdir(projectsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const candidateRoot = path.join(projectsRoot, dirent.name);
    const candidates = await walkTree(candidateRoot, {
      include: (candidate) => !candidate.logicalPath.includes('/') && candidate.logicalPath.endsWith('.jsonl'),
      descend: () => false,
    });
    for (const candidate of candidates) {
      if ((await Promise.all(
        equivalentMacPaths(source).map((sourceVariant) => fileMentionsProject(candidate.absolutePath, sourceVariant)),
      )).some(Boolean)) {
        return { key: dirent.name, path: candidateRoot, method: 'session-cwd-evidence' };
      }
    }
  }
  return null;
}

function sessionIdsFrom(candidates, projectKey) {
  const ids = new Set();
  const prefix = `projects/${projectKey}/`;
  for (const candidate of candidates) {
    if (!candidate.logicalPath.startsWith(prefix)) continue;
    const rest = candidate.logicalPath.slice(prefix.length);
    const first = rest.split('/')[0];
    if (first.endsWith('.jsonl')) ids.add(first.slice(0, -'.jsonl'.length));
  }
  return ids;
}

function selectedClaudePath(logicalPath, projectKey, sessionIds, isDirectory = false) {
  if (!logicalPath.includes('/')) {
    if (isDirectory) {
      return GLOBAL_DIRECTORIES.has(logicalPath) || SESSION_DIRECTORIES.has(logicalPath) || logicalPath === 'projects';
    }
    return secretPathReason(logicalPath) === null;
  }
  const [top, second] = logicalPath.split('/');
  if (GLOBAL_DIRECTORIES.has(top)) return true;
  if (top === 'projects') return second === projectKey;
  if (SESSION_DIRECTORIES.has(top)) {
    return [...sessionIds].some((sessionId) => second === sessionId || second?.includes(sessionId));
  }
  return false;
}

function shouldDescendClaudePath(logicalPath, projectKey, sessionIds) {
  const [top, second] = logicalPath.split('/');
  if (!second) {
    return GLOBAL_DIRECTORIES.has(top) || SESSION_DIRECTORIES.has(top) || top === 'projects';
  }
  if (GLOBAL_DIRECTORIES.has(top)) return true;
  if (top === 'projects') return second === projectKey;
  if (SESSION_DIRECTORIES.has(top)) {
    return [...sessionIds].some((sessionId) => second === sessionId || second?.includes(sessionId));
  }
  return false;
}

export async function previewClaudeState({ source, claudeHome: claudeHomeInput }) {
  const configuredHome = claudeHomeInput
    ?? process.env.CLAUDE_CONFIG_DIR
    ?? path.join(os.homedir(), '.claude');
  const claudeHome = await resolveExistingDirectory(path.resolve(configuredHome), 'Claude home');
  const project = await locateProjectDirectory(claudeHome, source);
  if (!project) {
    throw new Error(`No Claude Code project session directory matches the selected repository in ${claudeHome}/projects.`);
  }
  const projectCandidates = await walkTree(project.path);
  const sessionIds = sessionIdsFrom(
    projectCandidates.map((candidate) => ({
      ...candidate,
      logicalPath: `projects/${project.key}/${candidate.logicalPath}`,
    })),
    project.key,
  );
  const candidates = await walkTree(claudeHome, {
    include: (candidate, dirent) => selectedClaudePath(
      candidate.logicalPath,
      project.key,
      sessionIds,
      dirent.isDirectory(),
    ),
    descend: (candidate) => shouldDescendClaudePath(candidate.logicalPath, project.key, sessionIds),
  });
  const adjacentConfigPath = path.join(path.dirname(claudeHome), '.claude.json');
  const adjacentCandidates = await pathExists(adjacentConfigPath)
    ? [{ logicalPath: '.claude.json', absolutePath: adjacentConfigPath }]
    : [];
  return {
    claudeHome,
    projectKey: project.key,
    discoveryMethod: project.method,
    sessionIds: [...sessionIds].sort(),
    candidates,
    adjacentCandidates,
  };
}

export async function captureClaudeState({
  source,
  claudeHome,
  payloadRoot,
  maxEntries,
  maxBytes,
}) {
  const preview = await previewClaudeState({ source, claudeHome });
  const captured = await captureTree({
    source: preview.claudeHome,
    payloadRoot,
    trackedPaths: [],
    candidates: preview.candidates,
    payloadPrefix: 'payload/claude-home',
    inventoryReason: 'claude-code-restorable-state',
    scanSecrets: false,
    appendOnlyJsonl: true,
    maxEntries,
    maxBytes,
  });
  const adjacentCaptured = preview.adjacentCandidates.length === 0
    ? {
        entries: [],
        inventory: [],
        findings: [],
        totals: { entries: 0, bytes: 0, secretExclusions: 0, unstableEntries: 0 },
      }
    : await captureTree({
        source: path.dirname(preview.claudeHome),
        payloadRoot,
        trackedPaths: [],
        candidates: preview.adjacentCandidates,
        payloadPrefix: 'payload/claude-home',
        inventoryReason: 'claude-code-restorable-state',
        scanSecrets: false,
        maxEntries: Math.max(0, (maxEntries ?? 100_000) - captured.totals.entries),
        maxBytes: Math.max(0, (maxBytes ?? 5 * 1024 * 1024 * 1024) - captured.totals.bytes),
      });
  return {
    entries: [...captured.entries, ...adjacentCaptured.entries],
    inventory: [...captured.inventory, ...adjacentCaptured.inventory],
    findings: [...captured.findings, ...adjacentCaptured.findings],
    totals: {
      entries: captured.totals.entries + adjacentCaptured.totals.entries,
      bytes: captured.totals.bytes + adjacentCaptured.totals.bytes,
      secretExclusions: captured.totals.secretExclusions + adjacentCaptured.totals.secretExclusions,
      unstableEntries: captured.totals.unstableEntries + adjacentCaptured.totals.unstableEntries,
    },
    source: {
      adapter: 'claude-code',
      adapterVersion: '1.0.0',
      rootAlias: '$CLAUDE_CONFIG_DIR',
      absolutePathStored: false,
      projectKey: preview.projectKey,
      discoveryMethod: preview.discoveryMethod,
      sessionIds: preview.sessionIds,
    },
  };
}

export function restoredClaudeLogicalPath(logicalPath, oldProjectKey, destinationProject) {
  const projectPrefix = `projects/${oldProjectKey}`;
  if (logicalPath === projectPrefix || logicalPath.startsWith(`${projectPrefix}/`)) {
    return `projects/${encodeProjectPath(destinationProject)}${logicalPath.slice(projectPrefix.length)}`;
  }
  return logicalPath;
}
