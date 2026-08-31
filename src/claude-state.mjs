import { createReadStream } from 'node:fs';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { applyFileMetadata, captureTree, secretPathReason, walkTree } from './filesystem.mjs';
import { pathExists, resolveExistingDirectory, safeJoin, sha256File } from './util.mjs';

const GLOBAL_DIRECTORIES = new Set([
  'agents',
  'commands',
  'backups',
  'debug',
  'hooks',
  'image-cache',
  'memory',
  'output-styles',
  'paste-cache',
  'plans',
  'plugins',
  'shell-snapshots',
  'skills',
]);

const SESSION_DIRECTORIES = new Set([
  'file-history',
  'session-env',
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
      adapterVersion: '1.1.0',
      rootAlias: '$CLAUDE_CONFIG_DIR',
      absolutePathStored: true,
      sourceProjectPath: source,
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

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ');
  return text || null;
}

function compactText(value, limit = 240) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

async function inspectSessionFile(filePath, entry, sessionId, sourceProjectPath, relatedEntries) {
  const timestamps = [];
  const models = new Set();
  const branches = new Set();
  const recordedCwds = new Set();
  const claudeVersions = new Set();
  const entrypoints = new Set();
  let validRecords = 0;
  let malformedRecords = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let firstPrompt = null;
  let summary = null;
  let customTitle = null;
  let observedSessionId = null;

  const lines = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
      validRecords += 1;
    } catch {
      malformedRecords += 1;
      continue;
    }
    if (typeof record.sessionId === 'string') observedSessionId = record.sessionId;
    if (typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))) {
      timestamps.push(record.timestamp);
    }
    if (typeof record.cwd === 'string') recordedCwds.add(record.cwd);
    if (typeof record.gitBranch === 'string' && record.gitBranch) branches.add(record.gitBranch);
    if (typeof record.version === 'string' && record.version) claudeVersions.add(record.version);
    if (typeof record.entrypoint === 'string' && record.entrypoint) entrypoints.add(record.entrypoint);
    if (typeof record.message?.model === 'string') models.add(record.message.model);
    if (record.type === 'user' && record.message?.role === 'user') {
      userMessages += 1;
      if (!firstPrompt) firstPrompt = compactText(messageText(record.message));
    }
    if (record.type === 'assistant' && record.message?.role === 'assistant') assistantMessages += 1;
    if (record.type === 'summary') summary = compactText(record.summary) ?? summary;
    if (record.type === 'custom-title') {
      customTitle = compactText(record.customTitle ?? record.title) ?? customTitle;
    }
  }

  timestamps.sort();
  const sessionPrefix = `${entry.logicalPath.slice(0, -'.jsonl'.length)}/`;
  const subagentTranscripts = relatedEntries.filter((candidate) =>
    candidate.kind === 'file' &&
    candidate.logicalPath.startsWith(`${sessionPrefix}subagents/`) &&
    candidate.logicalPath.endsWith('.jsonl')).length;
  const toolResultFiles = relatedEntries.filter((candidate) =>
    candidate.kind === 'file' && candidate.logicalPath.startsWith(`${sessionPrefix}tool-results/`)).length;
  const sourceCwdObserved = [...recordedCwds].some((cwd) => equivalentMacPaths(sourceProjectPath).includes(cwd));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId);
  return {
    sessionId,
    title: customTitle ?? summary ?? firstPrompt ?? sessionId,
    customTitle,
    summary,
    firstPrompt,
    createdAt: timestamps[0] ?? null,
    updatedAt: timestamps.at(-1) ?? new Date(Number(BigInt(entry.metadata.mtimeNs) / 1_000_000n)).toISOString(),
    messageCount: userMessages + assistantMessages,
    userMessages,
    assistantMessages,
    models: [...models].sort(),
    gitBranches: [...branches].sort(),
    claudeVersions: [...claudeVersions].sort(),
    entrypoints: [...entrypoints].sort(),
    recordedCwds: [...recordedCwds].sort(),
    transcriptPath: entry.logicalPath,
    capturedBytes: entry.capturedLength,
    subagentTranscripts,
    toolResultFiles,
    validRecords,
    malformedRecords,
    observedSessionId,
    resumeById: uuid && validRecords > 0 && observedSessionId === sessionId && sourceCwdObserved,
    destinationPathRemapRequired: sourceCwdObserved,
    resumeCommand: `claude --resume ${sessionId}`,
  };
}

export async function buildClaudeSessionCatalog({ capsuleRoot, agentCapture, sourceProjectPath }) {
  const prefix = `projects/${agentCapture.source.projectKey}/`;
  const sessionEntries = agentCapture.entries.filter((entry) => {
    if (entry.kind !== 'file' || !entry.logicalPath.startsWith(prefix) || !entry.logicalPath.endsWith('.jsonl')) {
      return false;
    }
    return !entry.logicalPath.slice(prefix.length).includes('/');
  });
  const sessions = [];
  for (const entry of sessionEntries) {
    const sessionId = path.posix.basename(entry.logicalPath, '.jsonl');
    sessions.push(await inspectSessionFile(
      safeJoin(capsuleRoot, entry.payloadPath),
      entry,
      sessionId,
      sourceProjectPath,
      agentCapture.entries,
    ));
  }
  sessions.sort((first, second) =>
    String(second.updatedAt ?? '').localeCompare(String(first.updatedAt ?? '')) ||
    first.sessionId.localeCompare(second.sessionId));
  return {
    schemaVersion: '1.0.0',
    sourceAdapter: 'claude-code',
    projectKey: agentCapture.source.projectKey,
    sourceProjectPath,
    total: sessions.length,
    directlyResumable: sessions.filter((session) => session.resumeById).length,
    sessions,
  };
}

function pathBoundClaudeFile(sourceLogicalPath, oldProjectKey) {
  return sourceLogicalPath === '.claude.json' ||
    sourceLogicalPath === 'history.jsonl' ||
    sourceLogicalPath.startsWith(`projects/${oldProjectKey}/`) ||
    ['session-env/', 'tasks/', 'todos/', 'plans/'].some((prefix) => sourceLogicalPath.startsWith(prefix));
}

export async function remapRestoredClaudeState({
  claudeRoot,
  entries,
  oldProjectKey,
  sourceProjectPath,
  destinationProjectPath,
  variances,
}) {
  const destinationKey = encodeProjectPath(destinationProjectPath);
  const replacements = [
    ...equivalentMacPaths(sourceProjectPath).map((sourcePath) => [sourcePath, destinationProjectPath]),
    [oldProjectKey, destinationKey],
  ].filter(([from, to]) => from && from !== to)
    .sort(([first], [second]) => second.length - first.length);
  const remapped = [];
  const runtimeEntries = [];
  for (const entry of entries) {
    if (entry.kind !== 'file' || !pathBoundClaudeFile(entry.sourceLogicalPath ?? entry.logicalPath, oldProjectKey)) {
      runtimeEntries.push(entry);
      continue;
    }
    const target = safeJoin(claudeRoot, entry.logicalPath);
    const original = await readFile(target);
    if (original.includes(0)) {
      runtimeEntries.push(entry);
      continue;
    }
    let text = original.toString('utf8');
    let replacementCount = 0;
    for (const [from, to] of replacements) {
      const occurrences = text.split(from).length - 1;
      if (occurrences > 0) {
        text = text.replaceAll(from, to);
        replacementCount += occurrences;
      }
    }
    if (replacementCount === 0) {
      runtimeEntries.push(entry);
      continue;
    }
    await writeFile(target, text, { mode: entry.metadata?.mode ?? 0o600 });
    await applyFileMetadata(target, entry, variances);
    const runtimeEntry = {
      ...entry,
      sha256: await sha256File(target),
      restoredSize: Buffer.byteLength(text),
      pathRemapped: true,
    };
    runtimeEntries.push(runtimeEntry);
    remapped.push({
      path: entry.logicalPath,
      replacements: replacementCount,
      sourceSha256: entry.sha256,
      restoredSha256: runtimeEntry.sha256,
    });
  }
  return {
    runtimeEntries,
    remapped,
    sourceProjectPath,
    destinationProjectPath,
    oldProjectKey,
    destinationProjectKey: destinationKey,
  };
}

export async function verifyRestoredClaudeSessions({ claudeRoot, destinationProjectPath, sessions }) {
  const projectKey = encodeProjectPath(destinationProjectPath);
  const results = [];
  for (const session of sessions) {
    const transcript = path.join(claudeRoot, 'projects', projectKey, `${session.sessionId}.jsonl`);
    let records = 0;
    let matchingSessionRecords = 0;
    let matchingCwdRecords = 0;
    let malformedRecords = 0;
    if (await pathExists(transcript)) {
      const lines = readline.createInterface({ input: createReadStream(transcript), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          records += 1;
          if (record.sessionId === session.sessionId) matchingSessionRecords += 1;
          if (record.cwd === destinationProjectPath) matchingCwdRecords += 1;
        } catch {
          malformedRecords += 1;
        }
      }
    }
    const valid = records > 0 && matchingSessionRecords > 0 && matchingCwdRecords > 0;
    results.push({
      sessionId: session.sessionId,
      valid,
      transcript: `projects/${projectKey}/${session.sessionId}.jsonl`,
      records,
      matchingSessionRecords,
      matchingCwdRecords,
      malformedRecords,
      resumeCommand: `claude --resume ${session.sessionId}`,
    });
  }
  return {
    valid: results.every((result) => result.valid),
    projectKey,
    destinationProjectPath,
    sessionCount: results.length,
    sessions: results,
  };
}
