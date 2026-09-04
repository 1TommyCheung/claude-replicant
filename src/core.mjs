import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  link,
} from 'node:fs/promises';
import path from 'node:path';
import {
  buildClaudeSessionCatalog,
  captureClaudeState,
  previewClaudeState,
  remapRestoredClaudeState,
  restoredClaudeLogicalPath,
  verifyRestoredClaudeSessions,
} from './claude-state.mjs';
import {
  applyFileMetadata,
  captureTree,
  isPlatformMetadata,
  probeFilesystem,
  verifyTree,
  walkTree,
} from './filesystem.mjs';
import {
  captureGitSnapshot,
  comparableGitSnapshot,
  inspectGitLayout,
  probeGit,
} from './git.mjs';
import {
  FORMAT_VERSION,
  RESTORE_PLAN_SCHEMA,
  assertNodeVersion,
  cleanup,
  digestObject,
  ensureDirectory,
  isoNow,
  newId,
  pathExists,
  pathsOverlap,
  readJson,
  resolveExistingDirectory,
  safeJoin,
  sha256File,
  stableStringify,
  writeJson,
  writeJsonAtomic,
  writeTextAtomic,
} from './util.mjs';

const REPORT_FILES = [
  'inventory.jsonl',
  'capture-report.json',
  'capture-report.md',
  'capture-report.html',
  'sessions.json',
  'agent-environment-profile.json',
  'redaction-report.json',
  'restore-readiness.json',
];

const CAPSULE_FOLDER = 'capsule';
const GIT_SOURCE_KIND = 'git-repository';
const FOLDER_SOURCE_KIND = 'folder';

async function detectSourceKind(source) {
  const dotGit = await lstat(path.join(source, '.git')).catch(() => null);
  return dotGit ? GIT_SOURCE_KIND : FOLDER_SOURCE_KIND;
}

function capsuleUsesGit(manifest) {
  return manifest.source?.kind !== FOLDER_SOURCE_KIND;
}

function notApplicableGitLayout() {
  return {
    layout: 'not-applicable',
    pathBound: [],
    actualRestoreSupported: true,
  };
}

function notApplicableGitVerification() {
  return {
    applicable: false,
    valid: true,
    status: 'not-applicable',
    mismatches: [],
  };
}

export async function resolveCapsuleOperationPath({ capsule: capsuleInput, requested, filename }) {
  const capsule = await resolveExistingDirectory(path.resolve(capsuleInput), 'Capsule');
  const operations = path.join(capsule, 'operations');
  const operationsStats = await lstat(operations).catch(() => null);
  if (!operationsStats?.isDirectory() || operationsStats.isSymbolicLink()) {
    throw new Error(`Capsule operations folder is missing or unsafe: ${operations}`);
  }
  const target = requested ? path.resolve(requested) : path.join(operations, filename);
  const targetParent = await resolveExistingDirectory(path.dirname(target), 'Operational file parent');
  if (targetParent !== operations) {
    throw new Error(`Operational files must be stored directly inside the capsule operations folder: ${operations}`);
  }
  if (await pathExists(target)) throw new Error(`Operational file already exists: ${target}`);
  return target;
}

function agentEnvironmentProfile(agentCapture) {
  return {
    schemaVersion: '1.0.0',
    collectionStatus: 'complete',
    collectionPolicy: 'selected-project-plus-user-agent-environment',
    sourceAdapter: agentCapture.source.adapter,
    sourceRootAlias: agentCapture.source.rootAlias,
    projectKey: agentCapture.source.projectKey,
    sessionIds: agentCapture.source.sessionIds,
    capturedEntries: agentCapture.totals.entries,
    capturedBytes: agentCapture.totals.bytes,
    projectScoped: ['projects', 'file-history', 'session-env', 'tasks', 'todos'],
    userGlobal: ['agents', 'commands', 'hooks', 'memory', 'output-styles', 'plans', 'plugins', 'skills'],
    findings: agentCapture.findings,
  };
}

function readinessFrom({ capture, agentCapture, sourceKind, gitLayout, gitStable, filesystemProbe }) {
  const repoFindings = capture.findings.filter((finding) =>
    ['source-changed-during-capture', 'special-file-not-captured'].includes(finding.code));
  const gitApplicable = sourceKind === GIT_SOURCE_KIND;
  const gitFindings = gitApplicable
    ? [
        ...gitLayout.pathBound.map((binding) => ({
          code: `git-path-bound:${binding.kind}`,
          severity: 'blocker',
        })),
        ...capture.findings.filter((finding) => finding.code === 'git-lock-present'),
        ...(gitStable ? [] : [{ code: 'git-state-changed-during-capture', severity: 'blocker' }]),
      ]
    : [{ code: 'git-not-applicable', severity: 'informational' }];
  const metadataFindings = [
    {
      code: 'metadata-unobserved:xattrs-acls-bsd-flags',
      severity: 'action-required',
      message: 'Node reference does not observe or apply xattrs, ACLs, resource forks, or BSD flags.',
    },
    ...capture.findings.filter((finding) => finding.code === 'symlink-portability-risk'),
    ...Object.entries(filesystemProbe.capabilities)
      .filter(([, value]) => value === false || String(value).startsWith('unobserved'))
      .map(([capability, value]) => ({
        code: `filesystem-capability:${capability}`,
        value,
        severity: 'action-required',
      })),
    ...filesystemProbe.findings,
  ];
  const credentialFindings = capture.findings.filter((finding) => finding.code === 'credential-excluded');
  const domains = {
    repositoryData: {
      status: repoFindings.some((finding) => finding.severity === 'blocker') ? 'not-ready' : 'ready',
      findings: repoFindings,
    },
    gitState: {
      status: gitApplicable
        ? gitFindings.length === 0 && gitLayout.actualRestoreSupported ? 'ready' : 'not-ready'
        : 'not-applicable',
      findings: gitFindings,
    },
    filesystemMetadata: { status: 'action-required', findings: metadataFindings },
    agentState: {
      status: agentCapture.totals.unstableEntries === 0 ? 'ready' : 'not-ready',
      findings: agentCapture.findings,
    },
    agentEnvironment: {
      status: 'ready',
      findings: [],
    },
    credentials: {
      status: 'action-required',
      findings: credentialFindings.length
        ? credentialFindings
        : [{ code: 'credentials-not-captured', severity: 'action-required' }],
    },
    externalServices: {
      status: 'action-required',
      findings: [{ code: 'external-services-require-reauthentication', severity: 'action-required' }],
    },
  };
  const overall = Object.values(domains).some((domain) => domain.status === 'not-ready')
    ? 'not-ready'
    : Object.values(domains).some((domain) => domain.status === 'action-required')
      ? 'action-required'
      : 'ready';
  return {
    schemaVersion: '1.0.0',
    assessedAt: isoNow(),
    overall,
    domains,
    warnings: [
      'SECRET-BEARING: store and transfer this capsule as confidential data.',
      'Claude Code session transcripts and agent state are captured without content redaction.',
      'Dedicated credential stores are excluded; session text may still contain sensitive values.',
    ],
  };
}

function collisionFindings(entries, probe) {
  const findings = [];
  const caseMap = new Map();
  const unicodeMap = new Map();
  for (const entry of entries) {
    const folded = entry.logicalPath.toLocaleLowerCase('en-US');
    const normalized = entry.logicalPath.normalize('NFC');
    if (caseMap.has(folded) && caseMap.get(folded) !== entry.logicalPath) {
      findings.push({ code: 'case-collision', paths: [caseMap.get(folded), entry.logicalPath] });
    }
    if (unicodeMap.has(normalized) && unicodeMap.get(normalized) !== entry.logicalPath) {
      findings.push({ code: 'unicode-normalization-collision', paths: [unicodeMap.get(normalized), entry.logicalPath] });
    }
    caseMap.set(folded, entry.logicalPath);
    unicodeMap.set(normalized, entry.logicalPath);
  }
  return findings.filter((finding) =>
    (finding.code === 'case-collision' && probe.capabilities.caseSensitive === false) ||
    (finding.code === 'unicode-normalization-collision' && probe.capabilities.unicodeRoundTrip === false));
}

function captureMarkdown(report) {
  const sessionRows = report.sessions.length === 0
    ? ['_No resumable Claude Code sessions were captured._']
    : [
        '| Session ID | Title / first prompt | Updated | Messages | Branch | Resume |',
        '|---|---|---:|---:|---|---|',
        ...report.sessions.map((session) => {
          const clean = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ');
          return `| \`${clean(session.sessionId)}\` | ${clean(session.title)} | ${clean(session.updatedAt)} | ${session.messageCount} | ${clean(session.gitBranches.join(', '))} | \`${clean(session.resumeCommand)}\` |`;
        }),
      ];
  return [
    '# Claude Replicant Capture Report',
    '',
    `- Capsule: ${report.packageId}`,
    `- Source label: ${report.sourceLabel}`,
    `- Source type: ${report.sourceKind}`,
    `- Git: ${report.sourceKind === GIT_SOURCE_KIND ? 'captured and verified' : 'not applicable'}`,
    `- Captured: ${report.createdAt}`,
    `- Included entries: ${report.totals.entries}`,
    `- Included bytes: ${report.totals.bytes}`,
    `- Claude state entries: ${report.agentState.entries}`,
    `- Claude sessions: ${report.agentState.sessionCount}`,
    `- Directly resumable by ID: ${report.agentState.directlyResumable}`,
    `- Credential exclusions: ${report.totals.secretExclusions}`,
    `- Overall readiness: ${report.readiness}`,
    '',
    '> SECRET-BEARING: Treat this capsule and its store as confidential.',
    '',
    'Claude Code sessions, memory, subagents, plans, skills, commands, plugins, and related restorable state are included.',
    '',
    '## Captured Claude Code sessions',
    '',
    ...sessionRows,
    '',
    'After restore, start Claude Code from the restored project with the receipt’s `CLAUDE_CONFIG_DIR`, then run `claude --resume` or a listed `claude --resume <session-id>` command.',
    '',
  ].join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function captureHtml(report) {
  const warnings = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const sessionRows = report.sessions.length === 0
    ? '<tr><td colspan="6">No resumable Claude Code sessions were captured.</td></tr>'
    : report.sessions.map((session) => `<tr><td><code>${escapeHtml(session.sessionId)}</code></td><td>${escapeHtml(session.title)}</td><td>${escapeHtml(session.updatedAt ?? '')}</td><td>${session.messageCount}</td><td>${escapeHtml(session.gitBranches.join(', '))}</td><td><code>${escapeHtml(session.resumeCommand)}</code></td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Replicant Capture Report</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:3rem auto;padding:0 1.25rem;color:#17202a}h1{margin-bottom:.25rem}.card{border:1px solid #d9dee5;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}dt{font-weight:700}dd{margin:0 0 .6rem}code{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d9dee5;padding:.55rem}.warning{background:#fff8df;border-color:#e8c55d}
</style></head><body><h1>Claude Replicant Capture Report</h1><p>Self-contained migration capsule</p>
<section class="card"><dl><dt>Capsule</dt><dd><code>${escapeHtml(report.packageId)}</code></dd><dt>Project</dt><dd>${escapeHtml(report.sourceLabel)}</dd><dt>Source type</dt><dd>${escapeHtml(report.sourceKind)}</dd><dt>Git</dt><dd>${report.sourceKind === GIT_SOURCE_KIND ? 'Captured and verified' : 'Not applicable'}</dd><dt>Captured</dt><dd>${escapeHtml(report.createdAt)}</dd><dt>Readiness</dt><dd>${escapeHtml(report.readiness)}</dd></dl></section>
<section class="card"><h2>Contents</h2><ul><li>${report.repository.entries} project entries (${report.repository.bytes} bytes)</li><li>${report.agentState.entries} Claude state entries (${report.agentState.bytes} bytes)</li><li>${report.agentState.sessionCount} Claude sessions (${report.agentState.directlyResumable} directly resumable by ID)</li></ul></section>
<section class="card"><h2>Captured Claude Code sessions</h2><table><thead><tr><th>Session ID</th><th>Title / first prompt</th><th>Updated</th><th>Messages</th><th>Branch</th><th>Resume</th></tr></thead><tbody>${sessionRows}</tbody></table><p>After restore, launch Claude Code from the restored project with the receipt’s <code>CLAUDE_CONFIG_DIR</code>, then use <code>claude --resume</code> or a listed session ID.</p></section>
<section class="card warning"><h2>Handling</h2><ul>${warnings}</ul></section>
<p>This static report contains no scripts or remote resources. See <code>manifest.json</code> and <code>inventory.jsonl</code> for authoritative evidence.</p></body></html>\n`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function restoreMarkdown(receipt) {
  return [
    '# Claude Replicant Restore Report',
    '',
    `- Capsule: ${receipt.capsuleId}`,
    `- Source type: ${receipt.sourceKind}`,
    `- Project: ${receipt.destination}`,
    `- Git verification: ${receipt.gitVerification.applicable ? receipt.gitVerification.valid ? 'verified' : 'failed' : 'not applicable'}`,
    `- Claude home: ${receipt.claudeDestination}`,
    `- Native resume readiness: ${receipt.nativeResumeReadiness.valid ? 'verified' : 'failed'}`,
    `- Restored sessions: ${receipt.resume.sessions.length}`,
    '',
    '## Resume in Claude Code',
    '',
    '```sh',
    `cd ${shellQuote(receipt.destination)}`,
    `CLAUDE_CONFIG_DIR=${shellQuote(receipt.claudeDestination)} claude --resume`,
    '```',
    '',
    '| Session ID | Title / first prompt | Direct resume command |',
    '|---|---|---|',
    ...receipt.resume.sessions.map((session) =>
      `| \`${session.sessionId}\` | ${String(session.title ?? '').replaceAll('|', '\\|')} | \`CLAUDE_CONFIG_DIR=${shellQuote(receipt.claudeDestination)} ${session.command}\` |`),
    '',
  ].join('\n');
}

function restoreHtml(receipt) {
  const rows = receipt.resume.sessions.map((session) => `<tr><td><code>${escapeHtml(session.sessionId)}</code></td><td>${escapeHtml(session.title)}</td><td><code>CLAUDE_CONFIG_DIR=${escapeHtml(shellQuote(receipt.claudeDestination))} ${escapeHtml(session.command)}</code></td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Replicant Restore Report</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1000px;margin:3rem auto;padding:0 1.25rem;color:#17202a}section{border:1px solid #d9dee5;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d9dee5;padding:.55rem}code{overflow-wrap:anywhere}.ok{color:#176b35;font-weight:700}</style></head><body><h1>Claude Replicant Restore Report</h1><section><p class="ok">Native resume layout verified</p><dl><dt>Source type</dt><dd>${escapeHtml(receipt.sourceKind)}</dd><dt>Project</dt><dd><code>${escapeHtml(receipt.destination)}</code></dd><dt>Git verification</dt><dd>${receipt.gitVerification.applicable ? receipt.gitVerification.valid ? 'Verified' : 'Failed' : 'Not applicable'}</dd><dt>Claude home</dt><dd><code>${escapeHtml(receipt.claudeDestination)}</code></dd></dl><p>Run from the restored project:</p><pre><code>CLAUDE_CONFIG_DIR=${escapeHtml(shellQuote(receipt.claudeDestination))} claude --resume</code></pre></section><section><h2>Restored sessions</h2><table><thead><tr><th>Session ID</th><th>Title / first prompt</th><th>Direct resume</th></tr></thead><tbody>${rows}</tbody></table></section></body></html>\n`;
}

function filterStatusForPolicyExclusions(snapshot, excludedPaths) {
  const excluded = new Set(excludedPaths);
  return {
    ...snapshot,
    status: snapshot.status
      .split('\n')
      .filter((line) => {
        if (line.startsWith('? ') || line.startsWith('! ')) return !excluded.has(line.slice(2));
        return true;
      })
      .join('\n'),
  };
}

function indexedGitPaths(manifest) {
  return new Set((manifest.git?.after?.indexEntries ?? '')
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('\t');
      return separator === -1 ? null : line.slice(separator + 1);
    })
    .filter(Boolean));
}

function isIgnorableManifestPlatformMetadata({ entry, root, indexedPaths }) {
  if (entry.kind !== 'file' || !isPlatformMetadata(entry.logicalPath)) return false;
  if (root === 'claude-home') return true;
  if (entry.tracked === true) return false;
  if (entry.tracked === false) return true;
  return !indexedPaths.has(entry.logicalPath);
}

function restorableEntries(manifest) {
  const indexedPaths = indexedGitPaths(manifest);
  const repository = (manifest.entries ?? []).filter((entry) => !isIgnorableManifestPlatformMetadata({
    entry,
    root: 'repository',
    indexedPaths,
  }));
  const agent = (manifest.agentState?.entries ?? []).filter((entry) => !isIgnorableManifestPlatformMetadata({
    entry,
    root: 'claude-home',
    indexedPaths,
  }));
  return { repository, agent };
}

async function initializeCapsuleRoot(store) {
  await mkdir(store, { recursive: true, mode: 0o700 });
  await mkdir(path.join(store, CAPSULE_FOLDER), { recursive: true, mode: 0o700 });
}

async function resolveSourceAndStore(sourceInput, storeInput, { createStore = false } = {}) {
  const source = await resolveExistingDirectory(path.resolve(sourceInput), 'Source');
  const store = path.resolve(storeInput);
  if (await pathExists(store)) {
    await ensureDirectory(store, 'Store');
  } else if (!createStore) {
    const parent = path.dirname(store);
    await ensureDirectory(parent, 'Store parent');
  }
  const overlapBase = (await pathExists(store)) ? await resolveExistingDirectory(store, 'Store') : store;
  if (pathsOverlap(source, overlapBase)) {
    throw new Error('Source project and capsule store must not overlap.');
  }
  return { source, store };
}

export async function previewCapture({
  source: sourceInput,
  store: storeInput,
  claudeHome,
  gitPath = 'git',
}) {
  assertNodeVersion();
  if (!sourceInput || !storeInput) throw new Error('Capture requires explicit --source and --store paths.');
  const { source, store } = await resolveSourceAndStore(sourceInput, storeInput);
  const sourceKind = await detectSourceKind(source);
  const candidates = await walkTree(source);
  const claude = await previewClaudeState({ source, claudeHome });
  if (sourceKind === FOLDER_SOURCE_KIND) {
    return {
      mode: 'preview',
      source,
      sourceKind,
      store,
      candidateEntries: candidates.length,
      claudeState: {
        rootAlias: '$CLAUDE_CONFIG_DIR',
        projectKey: claude.projectKey,
        discoveryMethod: claude.discoveryMethod,
        sessionCount: claude.sessionIds.length,
        candidateEntries: claude.candidates.length + claude.adjacentCandidates.length,
      },
      git: { applicable: false, status: 'not-applicable', layout: 'not-applicable' },
      warnings: [
        'No files were written. Re-run with --confirm to create a capsule.',
        'Git is not applicable because the selected source has no .git entry.',
        'Known credential files are excluded.',
        'Claude Code sessions and agent state will be captured as confidential, restorable data.',
      ],
    };
  }
  const git = await probeGit(gitPath);
  const gitLayout = await inspectGitLayout(source);
  if (!gitLayout.actualRestoreSupported) {
    return {
      mode: 'preview',
      source,
      store,
      candidateEntries: candidates.length,
      claudeState: {
        rootAlias: '$CLAUDE_CONFIG_DIR',
        projectKey: claude.projectKey,
        sessionCount: claude.sessionIds.length,
        candidateEntries: claude.candidates.length + claude.adjacentCandidates.length,
      },
      git: { applicable: true, ...git, layout: gitLayout.layout, pathBound: gitLayout.pathBound },
      blockers: [{ code: 'git-layout-unsupported-for-part1', findings: gitLayout.pathBound }],
      warnings: ['No files were written. Capture cannot proceed for this Git layout.'],
    };
  }
  const gitSnapshot = await captureGitSnapshot(source, git);
  return {
    mode: 'preview',
    source,
    sourceKind,
    store,
    candidateEntries: candidates.length,
    claudeState: {
      rootAlias: '$CLAUDE_CONFIG_DIR',
      projectKey: claude.projectKey,
      discoveryMethod: claude.discoveryMethod,
      sessionCount: claude.sessionIds.length,
      candidateEntries: claude.candidates.length + claude.adjacentCandidates.length,
    },
    git: {
      applicable: true,
      ...git,
      layout: gitLayout.layout,
      pathBound: gitLayout.pathBound,
      head: gitSnapshot.head,
      symbolicHead: gitSnapshot.symbolicHead,
    },
    warnings: [
      'No files were written. Re-run with --confirm to create a capsule.',
      'Known credential files are excluded; tracked credential material blocks capture.',
      'Claude Code sessions and agent state will be captured as confidential, restorable data.',
    ],
  };
}

export async function captureRepository({
  source: sourceInput,
  store: storeInput,
  claudeHome,
  gitPath = 'git',
  confirm = false,
  maxEntries,
  maxBytes,
  beforeTreeCapture,
}) {
  if (!confirm) return previewCapture({ source: sourceInput, store: storeInput, claudeHome, gitPath });
  assertNodeVersion();
  const { source, store } = await resolveSourceAndStore(sourceInput, storeInput, { createStore: true });
  const sourceKind = await detectSourceKind(source);
  const claudePreview = await previewClaudeState({ source, claudeHome });
  if (pathsOverlap(claudePreview.claudeHome, store)) {
    throw new Error('Claude home and capsule store must not overlap.');
  }
  await initializeCapsuleRoot(store);
  const storeProbe = await probeFilesystem(store);
  if (!storeProbe.capabilities.atomicRename) {
    throw new Error('Destination store failed the atomic rename capability probe.');
  }
  let git = null;
  let gitLayout = notApplicableGitLayout();
  let gitBefore = null;
  if (sourceKind === GIT_SOURCE_KIND) {
    git = await probeGit(gitPath);
    gitLayout = await inspectGitLayout(source);
    if (!gitLayout.actualRestoreSupported) {
      throw new Error(`Part 1 does not support this Git layout: ${JSON.stringify(gitLayout.pathBound)}`);
    }
    gitBefore = await captureGitSnapshot(source, git);
  }
  const sourceCandidates = await walkTree(source);
  const storeCollisions = collisionFindings(sourceCandidates, storeProbe);
  if (storeCollisions.length > 0) {
    throw new Error(`Destination store cannot represent source filenames: ${JSON.stringify(storeCollisions)}`);
  }
  const packageId = newId('capsule');
  const staging = path.join(store, CAPSULE_FOLDER, `.staging-${packageId}`);
  const finalPath = path.join(store, CAPSULE_FOLDER, packageId);
  const payloadRoot = path.join(staging, 'payload', 'repository');
  const agentPayloadRoot = path.join(staging, 'payload', 'claude-home');
  const startedAt = isoNow();
  await mkdir(payloadRoot, { recursive: true, mode: 0o700 });
  await mkdir(agentPayloadRoot, { recursive: true, mode: 0o700 });
  await mkdir(path.join(staging, 'operations'), { recursive: true, mode: 0o700 });

  try {
    if (beforeTreeCapture) await beforeTreeCapture({ source, store, packageId });
    const captured = await captureTree({
      source,
      payloadRoot,
      trackedPaths: gitBefore?.trackedPaths ?? [],
      candidates: sourceCandidates,
      maxEntries,
      maxBytes,
    });
    const entryLimit = maxEntries ?? 100_000;
    const byteLimit = maxBytes ?? 5 * 1024 * 1024 * 1024;
    const agentCaptured = await captureClaudeState({
      source,
      claudeHome: claudePreview.claudeHome,
      payloadRoot: agentPayloadRoot,
      maxEntries: entryLimit - captured.totals.entries,
      maxBytes: byteLimit - captured.totals.bytes,
    });
    if (captured.totals.unstableEntries > 0) {
      throw new Error('Source changed during capture; quiesce the project and retry.');
    }
    if (agentCaptured.totals.unstableEntries > 0) {
      throw new Error('Claude Code state changed incompatibly during capture; quiesce Claude Code and retry.');
    }
    const sessionCatalog = await buildClaudeSessionCatalog({
      capsuleRoot: staging,
      agentCapture: agentCaptured,
      sourceProjectPath: source,
    });
    if (sourceKind === FOLDER_SOURCE_KIND) {
      const sourceCandidatesAfter = await walkTree(source);
      if (stableStringify(
        sourceCandidates.map((candidate) => candidate.logicalPath),
      ) !== stableStringify(sourceCandidatesAfter.map((candidate) => candidate.logicalPath))) {
        throw new Error('Source folder structure changed during capture; quiesce the project and retry.');
      }
    }
    const gitAfter = sourceKind === GIT_SOURCE_KIND ? await captureGitSnapshot(source, git) : null;
    const gitStable = sourceKind === GIT_SOURCE_KIND
      ? gitBefore.snapshotDigest === gitAfter.snapshotDigest
      : null;
    const excludedPaths = captured.inventory
      .filter((record) => record.decision === 'excluded' && (
        record.sensitivity === 'credential' || record.reason === 'platform-metadata-policy'
      ))
      .map((record) => record.logicalPath);
    const expectedGitBefore = sourceKind === GIT_SOURCE_KIND
      ? filterStatusForPolicyExclusions(comparableGitSnapshot(gitBefore), excludedPaths)
      : null;
    const expectedGitAfter = sourceKind === GIT_SOURCE_KIND
      ? filterStatusForPolicyExclusions(comparableGitSnapshot(gitAfter), excludedPaths)
      : null;
    const readiness = readinessFrom({
      capture: captured,
      agentCapture: agentCaptured,
      sourceKind,
      gitLayout,
      gitStable,
      filesystemProbe: storeProbe,
    });
    const agentEnvironment = agentEnvironmentProfile(agentCaptured);
    const combinedTotals = {
      entries: captured.totals.entries + agentCaptured.totals.entries,
      bytes: captured.totals.bytes + agentCaptured.totals.bytes,
      secretExclusions: captured.totals.secretExclusions + agentCaptured.totals.secretExclusions,
      unstableEntries: captured.totals.unstableEntries + agentCaptured.totals.unstableEntries,
    };
    const report = {
      schemaVersion: FORMAT_VERSION,
      packageId,
      createdAt: isoNow(),
      captureWindow: { startedAt, endedAt: isoNow() },
      sourceLabel: path.basename(source),
      sourceKind,
      totals: combinedTotals,
      repository: captured.totals,
      agentState: {
        ...agentCaptured.totals,
        sessionCount: sessionCatalog.total,
        directlyResumable: sessionCatalog.directlyResumable,
      },
      sessions: sessionCatalog.sessions,
      readiness: readiness.overall,
      agentEnvironmentStatus: agentEnvironment.collectionStatus,
      warnings: readiness.warnings,
    };
    const redaction = {
      schemaVersion: FORMAT_VERSION,
      credentialFilesExcluded: combinedTotals.secretExclusions,
      contentRedactionApplied: false,
      rawSessionContentPersisted: true,
      dedicatedCredentialStoresExcluded: true,
      findings: captured.findings.filter((finding) => finding.code === 'credential-excluded'),
    };

    await writeTextAtomic(
      path.join(staging, 'inventory.jsonl'),
      `${captured.inventory.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    await appendFile(
      path.join(staging, 'inventory.jsonl'),
      `${agentCaptured.inventory.map((record) => JSON.stringify({ ...record, rootAlias: '$CLAUDE_CONFIG_DIR' })).join('\n')}\n`,
    );
    await writeJson(path.join(staging, 'capture-report.json'), report);
    await writeTextAtomic(path.join(staging, 'capture-report.md'), captureMarkdown(report));
    await writeTextAtomic(path.join(staging, 'capture-report.html'), captureHtml(report));
    await writeJson(path.join(staging, 'sessions.json'), sessionCatalog);
    await writeJson(path.join(staging, 'agent-environment-profile.json'), agentEnvironment);
    await writeJson(path.join(staging, 'redaction-report.json'), redaction);
    await writeJson(path.join(staging, 'restore-readiness.json'), readiness);

    const reports = {};
    for (const reportFile of REPORT_FILES) {
      reports[reportFile] = await sha256File(path.join(staging, reportFile));
    }
    const manifestWithoutDigest = {
      schemaVersion: FORMAT_VERSION,
      packageId,
      packageType: 'forensic-backup',
      fidelityClass: 'F0-target',
      createdAt: report.createdAt,
      source: {
        label: path.basename(source),
        kind: sourceKind,
        absolutePathStored: true,
        originalPath: source,
        projectRootAlias: '$PROJECT_ROOT',
      },
      runtime: {
        name: 'node',
        version: process.versions.node,
        executable: process.execPath,
        supportedRange: '>=22.0.0 <23.0.0',
      },
      filesystem: { sourcePlatform: process.platform, storeProbe },
      policy: {
        scope: 'project-plus-restorable-claude-code-state',
        credentials: 'excluded-no-encryption-envelope',
        agentState: 'captured-with-execution-as-authorization',
        repositoryCodeExecution: 'forbidden',
        limits: {
          maxEntries: maxEntries ?? 100_000,
          maxBytes: maxBytes ?? 5 * 1024 * 1024 * 1024,
        },
      },
      git: {
        applicable: sourceKind === GIT_SOURCE_KIND,
        prerequisite: git,
        layout: gitLayout,
        before: expectedGitBefore,
        after: expectedGitAfter,
        stable: gitStable,
        reconstruction: sourceKind === GIT_SOURCE_KIND
          ? 'byte-for-byte-dot-git-and-index'
          : 'not-applicable',
      },
      entries: captured.entries,
      agentState: {
        ...agentCaptured.source,
        entries: agentCaptured.entries,
        sessionCatalog: {
          report: 'sessions.json',
          total: sessionCatalog.total,
          directlyResumable: sessionCatalog.directlyResumable,
        },
        reconstruction: 'isolated-claude-config-dir-with-project-path-remap',
      },
      findings: [...captured.findings, ...agentCaptured.findings],
      reports,
      readiness,
    };
    const manifest = {
      ...manifestWithoutDigest,
      manifestDigest: digestObject(manifestWithoutDigest),
    };
    await writeJson(path.join(staging, 'manifest.json'), manifest);

    const validation = await validateCapsule(staging);
    await writeJson(path.join(staging, 'validation.json'), validation);
    if (!validation.valid) {
      throw new Error(`Staged capsule failed validation: ${JSON.stringify(validation.errors)}`);
    }
    await rename(staging, finalPath);
    return {
      mode: 'captured',
      capsulePath: finalPath,
      packageId,
      sourceKind,
      manifestDigest: manifest.manifestDigest,
      validation,
      readiness,
    };
  } catch (error) {
    await cleanup(staging);
    throw error;
  }
}

export async function validateCapsule(capsuleInput) {
  assertNodeVersion();
  const capsule = await resolveExistingDirectory(path.resolve(capsuleInput), 'Capsule');
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(capsule, 'manifest.json');
  const manifest = await readJson(manifestPath).catch((error) => {
    errors.push({ code: 'manifest-invalid', message: error.message });
    return null;
  });
  if (!manifest) return { valid: false, checkedAt: isoNow(), errors, warnings };
  if (manifest.schemaVersion !== FORMAT_VERSION) {
    errors.push({ code: 'unsupported-manifest-version', actual: manifest.schemaVersion });
  }
  const expectedManifestDigest = digestObject(manifest, 'manifestDigest');
  if (expectedManifestDigest !== manifest.manifestDigest) {
    errors.push({ code: 'manifest-digest-mismatch' });
  }
  const sourceKind = manifest.source?.kind ?? GIT_SOURCE_KIND;
  if (![GIT_SOURCE_KIND, FOLDER_SOURCE_KIND].includes(sourceKind)) {
    errors.push({ code: 'unsupported-source-kind', actual: sourceKind });
  }
  if (sourceKind === FOLDER_SOURCE_KIND) {
    if (manifest.git?.applicable !== false || manifest.git?.before !== null || manifest.git?.after !== null) {
      errors.push({ code: 'folder-source-git-contract-mismatch' });
    }
    if (manifest.git?.reconstruction !== 'not-applicable') {
      errors.push({ code: 'folder-source-git-reconstruction-mismatch' });
    }
    if (manifest.readiness?.domains?.gitState?.status !== 'not-applicable') {
      errors.push({ code: 'folder-source-git-readiness-mismatch' });
    }
    if ((manifest.entries ?? []).some((entry) => (
      entry.logicalPath === '.git' || entry.logicalPath.startsWith('.git/')
    ))) {
      errors.push({ code: 'folder-source-contains-git-state' });
    }
  } else if (manifest.git?.applicable === false) {
    errors.push({ code: 'git-source-marked-not-applicable' });
  }

  const entryGroups = [
    { name: 'repository', entries: manifest.entries ?? [], payloadRoot: 'payload/repository' },
    { name: 'claude-home', entries: manifest.agentState?.entries ?? [], payloadRoot: 'payload/claude-home' },
  ];
  const indexedPaths = indexedGitPaths(manifest);
  const seenPayloads = new Set();
  for (const { name, entries } of entryGroups) {
    const seen = new Set();
    for (const entry of entries) {
    if (seen.has(entry.logicalPath)) {
      errors.push({ code: 'duplicate-logical-path', path: entry.logicalPath });
      continue;
    }
    seen.add(entry.logicalPath);
    if (seenPayloads.has(entry.payloadPath)) {
      errors.push({ code: 'duplicate-payload-path', path: entry.payloadPath });
      continue;
    }
    seenPayloads.add(entry.payloadPath);
    let payload;
    try {
      payload = safeJoin(capsule, entry.payloadPath);
    } catch (error) {
      errors.push({ code: 'unsafe-payload-path', path: entry.logicalPath, message: error.message });
      continue;
    }
    const stats = await lstat(payload).catch(() => null);
    if (isIgnorableManifestPlatformMetadata({ entry, root: name, indexedPaths })) {
      const actualDigest = stats?.isFile() ? await sha256File(payload) : null;
      warnings.push({
        code: 'ignored-manifest-platform-metadata',
        root: name,
        path: entry.logicalPath,
        state: !stats ? 'missing' : actualDigest === entry.sha256 ? 'unchanged' : 'modified',
      });
      continue;
    }
    if (!stats) {
      errors.push({ code: 'missing-payload', root: name, path: entry.logicalPath });
      continue;
    }
    if (entry.kind === 'file') {
      if (!stats.isFile()) errors.push({ code: 'payload-kind-mismatch', path: entry.logicalPath });
      else if ((await sha256File(payload)) !== entry.sha256) {
        errors.push({ code: 'payload-hash-mismatch', path: entry.logicalPath });
      }
    } else if (entry.kind === 'directory' && !stats.isDirectory()) {
      errors.push({ code: 'payload-kind-mismatch', path: entry.logicalPath });
    } else if (entry.kind === 'symlink') {
      if (!stats.isSymbolicLink()) errors.push({ code: 'payload-kind-mismatch', path: entry.logicalPath });
      else if ((await readlink(payload)) !== entry.linkTarget) {
        errors.push({ code: 'payload-symlink-target-mismatch', path: entry.logicalPath });
      }
    }
    }
  }

  for (const group of entryGroups) {
    const payloadRoot = path.join(capsule, ...group.payloadRoot.split('/'));
    const expected = new Set(group.entries.map((entry) => entry.logicalPath));
    if (await pathExists(payloadRoot)) {
      const payloadEntries = await walkTree(payloadRoot);
      for (const extra of payloadEntries) {
        if (expected.has(extra.logicalPath)) continue;
        const stats = await lstat(extra.absolutePath).catch(() => null);
        if (stats?.isFile() && isPlatformMetadata(extra.logicalPath)) {
          warnings.push({
            code: 'ignored-unreferenced-platform-metadata',
            root: group.name,
            path: extra.logicalPath,
          });
        } else {
          errors.push({ code: 'unreferenced-payload', root: group.name, path: extra.logicalPath });
        }
      }
    } else {
      errors.push({ code: 'missing-payload-root', root: group.name });
    }
  }

  for (const [reportFile, expectedDigest] of Object.entries(manifest.reports ?? {})) {
    const reportPath = path.join(capsule, reportFile);
    if (!(await pathExists(reportPath))) errors.push({ code: 'missing-report', path: reportFile });
    else if ((await sha256File(reportPath)) !== expectedDigest) {
      errors.push({ code: 'report-hash-mismatch', path: reportFile });
    }
  }

  return {
    schemaVersion: FORMAT_VERSION,
    valid: errors.length === 0,
    checkedAt: isoNow(),
    capsulePath: capsule,
    packageId: manifest.packageId,
    manifestDigest: manifest.manifestDigest,
    errors,
    warnings,
  };
}

async function destinationProbe(destination) {
  const parent = path.dirname(destination);
  await ensureDirectory(parent, 'Destination parent');
  if (await pathExists(destination)) throw new Error(`Destination must not exist: ${destination}`);
  return probeFilesystem(parent);
}

async function resolveNewDestination(destinationInput, label) {
  const requested = path.resolve(destinationInput);
  const parent = await resolveExistingDirectory(path.dirname(requested), `${label} parent`);
  return path.join(parent, path.basename(requested));
}

export async function createRestorePlan({
  capsule: capsuleInput,
  destination: destinationInput,
  claudeDestination: claudeDestinationInput,
}) {
  assertNodeVersion();
  if (!capsuleInput || !destinationInput) throw new Error('Plan requires --capsule and --destination.');
  const capsule = await resolveExistingDirectory(path.resolve(capsuleInput), 'Capsule');
  const destination = await resolveNewDestination(destinationInput, 'Destination');
  const claudeDestination = await resolveNewDestination(
    claudeDestinationInput ?? `${destination}.claude-home`,
    'Claude destination',
  );
  if (pathsOverlap(capsule, destination)) throw new Error('Capsule and restore destination must not overlap.');
  if (pathsOverlap(capsule, claudeDestination)) throw new Error('Capsule and Claude restore destination must not overlap.');
  if (pathsOverlap(destination, claudeDestination)) {
    throw new Error('Repository and Claude restore destinations must be separate, non-overlapping paths.');
  }
  const validation = await validateCapsule(capsule);
  const portableValidation = { ...validation, capsulePath: '$CAPSULE_ROOT' };
  const manifest = await readJson(path.join(capsule, 'manifest.json'));
  const effectiveEntries = restorableEntries(manifest);
  const gitApplicable = capsuleUsesGit(manifest);
  const blockers = [];
  if (!validation.valid) blockers.push({ code: 'capsule-invalid', errors: validation.errors });
  if (manifest.readiness.domains.repositoryData.status === 'not-ready') {
    blockers.push({ code: 'repository-data-not-ready' });
  }
  if (gitApplicable && manifest.readiness.domains.gitState.status !== 'ready') {
    blockers.push({ code: 'git-state-not-ready', findings: manifest.readiness.domains.gitState.findings });
  }
  if (manifest.readiness.domains.agentState.status !== 'ready') {
    blockers.push({ code: 'agent-state-not-ready', findings: manifest.readiness.domains.agentState.findings });
  }
  const git = gitApplicable
    ? await probeGit('git').catch((error) => {
        blockers.push({ code: 'git-prerequisite-unavailable', message: error.message });
        return null;
      })
    : null;
  const probe = await destinationProbe(destination);
  const claudeProbe = await destinationProbe(claudeDestination);
  if (!probe.capabilities.atomicRename) blockers.push({ code: 'destination-atomic-rename-unavailable' });
  if (!probe.capabilities.symlink && effectiveEntries.repository.some((entry) => entry.kind === 'symlink')) {
    blockers.push({ code: 'destination-symlink-unavailable' });
  }
  if (!claudeProbe.capabilities.atomicRename) blockers.push({ code: 'claude-destination-atomic-rename-unavailable' });
  if (!claudeProbe.capabilities.symlink && effectiveEntries.agent.some((entry) => entry.kind === 'symlink')) {
    blockers.push({ code: 'claude-destination-symlink-unavailable' });
  }
  const destinationCollisions = collisionFindings(effectiveEntries.repository, probe);
  blockers.push(...destinationCollisions.map((finding) => ({
    code: `destination-${finding.code}`,
    paths: finding.paths,
  })));
  const mappedAgentEntries = effectiveEntries.agent.map((entry) => ({
    ...entry,
    sourceLogicalPath: entry.logicalPath,
    logicalPath: restoredClaudeLogicalPath(
      entry.logicalPath,
      manifest.agentState.projectKey,
      destination,
    ),
  }));
  const claudeCollisions = collisionFindings(mappedAgentEntries, claudeProbe);
  blockers.push(...claudeCollisions.map((finding) => ({
    code: `claude-destination-${finding.code}`,
    paths: finding.paths,
  })));

  const variances = [
    { code: 'metadata-variance:uid-gid-not-applied' },
    { code: 'metadata-variance:birthtime-ctime-not-applied' },
    { code: 'metadata-variance:xattrs-acls-flags-unobserved-not-applied' },
    ...Object.entries(probe.capabilities)
      .filter(([, value]) => value === false || String(value).startsWith('unobserved'))
      .map(([capability, value]) => ({
        code: `destination-capability-variance:${capability}`,
        value,
      })),
    ...effectiveEntries.repository
      .filter((entry) => (entry.metadata?.sourceSpecialMode ?? 0) !== 0)
      .map((entry) => ({
        code: 'metadata-variance:special-mode-bits-not-applied',
        path: entry.logicalPath,
        sourceSpecialMode: entry.metadata.sourceSpecialMode,
      })),
    ...effectiveEntries.repository
      .filter((entry) => entry.kind === 'symlink' && entry.targetClass !== 'relative-in-scope')
      .map((entry) => ({ code: 'symlink-portability-risk', path: entry.logicalPath, targetClass: entry.targetClass })),
  ];
  const operations = effectiveEntries.repository.map((entry) => ({
    operation: entry.kind === 'directory'
      ? 'mkdir'
      : entry.kind === 'symlink'
        ? 'symlink'
        : entry.hardlinkGroup
          ? 'write-or-hardlink'
          : 'write-file',
    logicalPath: entry.logicalPath,
    sourcePayload: entry.payloadPath,
    expectedSha256: entry.sha256,
    hardlinkGroup: entry.hardlinkGroup,
    mode: entry.metadata?.mode,
  }));
  const agentOperations = mappedAgentEntries.map((entry) => ({
    operation: entry.kind === 'directory'
      ? 'mkdir'
      : entry.kind === 'symlink'
        ? 'symlink'
        : entry.hardlinkGroup
          ? 'write-or-hardlink'
          : 'write-file',
    logicalPath: entry.logicalPath,
    sourceLogicalPath: manifest.agentState.entries.find((sourceEntry) => sourceEntry.payloadPath === entry.payloadPath)?.logicalPath,
    sourcePayload: entry.payloadPath,
    expectedSha256: entry.sha256,
    hardlinkGroup: entry.hardlinkGroup,
    mode: entry.metadata?.mode,
  }));
  const planWithoutDigest = {
    schema: RESTORE_PLAN_SCHEMA,
    planId: newId('plan'),
    createdAt: isoNow(),
    capsulePath: '$CAPSULE_ROOT',
    capsuleId: manifest.packageId,
    manifestDigest: manifest.manifestDigest,
    sourceKind: manifest.source?.kind ?? GIT_SOURCE_KIND,
    destination,
    claudeDestination,
    activation: `CLAUDE_CONFIG_DIR=${claudeDestination}`,
    runtime: { name: 'node', version: process.versions.node },
    git,
    destinationProbe: probe,
    claudeDestinationProbe: claudeProbe,
    validation: portableValidation,
    executable: blockers.length === 0,
    blockers,
    operations,
    agentOperations,
    declaredVariances: variances,
    approvalRequired: true,
  };
  return { ...planWithoutDigest, planDigest: digestObject(planWithoutDigest) };
}

function verifyPlanDigest(plan) {
  if (plan.schema !== RESTORE_PLAN_SCHEMA) throw new Error(`Unsupported restore plan schema: ${plan.schema}`);
  if (plan.capsulePath !== '$CAPSULE_ROOT') throw new Error('Restore plan must use the portable $CAPSULE_ROOT reference.');
  const expected = digestObject(plan, 'planDigest');
  if (expected !== plan.planDigest) throw new Error('Restore plan digest mismatch.');
}

async function applyEntry({ capsule, staging, entry, hardlinks, variances }) {
  const source = safeJoin(capsule, entry.payloadPath);
  const destination = safeJoin(staging, entry.logicalPath);
  if (entry.kind === 'directory') {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (entry.kind === 'symlink') {
    await symlink(entry.linkTarget, destination);
    return;
  }
  if (entry.hardlinkGroup && hardlinks.has(entry.hardlinkGroup)) {
    try {
      await link(hardlinks.get(entry.hardlinkGroup), destination);
    } catch (error) {
      await copyFile(source, destination);
      variances.push({
        code: 'metadata-variance:hardlink-not-preserved',
        path: entry.logicalPath,
        message: error.message,
      });
    }
  } else {
    await copyFile(source, destination);
    if (entry.hardlinkGroup) hardlinks.set(entry.hardlinkGroup, destination);
  }
  await applyFileMetadata(destination, entry, variances);
}

async function verifyGitAfterRestore({ destination, manifest, git }) {
  const snapshot = await captureGitSnapshot(destination, git);
  const restorablePaths = new Set(restorableEntries(manifest).repository.map((entry) => entry.logicalPath));
  const ignoredPaths = (manifest.entries ?? [])
    .filter((entry) => !restorablePaths.has(entry.logicalPath))
    .map((entry) => entry.logicalPath);
  const expected = filterStatusForPolicyExclusions(manifest.git.after, ignoredPaths);
  const actual = comparableGitSnapshot(snapshot);
  const fields = ['head', 'symbolicHead', 'refs', 'status', 'indexEntries', 'indexDigest'];
  const mismatches = fields
    .filter((field) => stableStringify(expected[field]) !== stableStringify(actual[field]))
    .map((field) => ({ field, expected: expected[field], actual: actual[field] }));
  return {
    applicable: true,
    valid: mismatches.length === 0,
    status: mismatches.length === 0 ? 'verified' : 'failed',
    mismatches,
    snapshot: actual,
  };
}

async function applyTreeEntries({ capsule, staging, entries, variances }) {
  const hardlinks = new Map();
  const directories = entries.filter((entry) => entry.kind === 'directory');
  const nonDirectories = entries.filter((entry) => entry.kind !== 'directory');
  for (const entry of directories) await applyEntry({ capsule, staging, entry, hardlinks, variances });
  for (const entry of nonDirectories) await applyEntry({ capsule, staging, entry, hardlinks, variances });
  for (const entry of [...directories].sort((a, b) => b.logicalPath.length - a.logicalPath.length)) {
    await applyFileMetadata(safeJoin(staging, entry.logicalPath), entry, variances);
  }
}

export async function restoreFromPlan({ plan: planInput, approve = false, receipt: receiptInput }) {
  assertNodeVersion();
  if (!approve) throw new Error('Actual restore requires explicit --approve.');
  const planPath = path.resolve(planInput);
  const plan = await readJson(planPath);
  verifyPlanDigest(plan);
  const planDirectory = await resolveExistingDirectory(path.dirname(planPath), 'Restore plan parent');
  if (path.basename(planDirectory) !== 'operations') {
    throw new Error('Restore plan must be stored directly inside its capsule operations folder.');
  }
  const planCapsule = await resolveExistingDirectory(path.dirname(planDirectory), 'Capsule');
  if (!plan.executable || plan.blockers.length > 0) {
    throw new Error(`Restore plan is not executable: ${JSON.stringify(plan.blockers)}`);
  }
  const validation = await validateCapsule(planCapsule);
  if (!validation.valid || validation.manifestDigest !== plan.manifestDigest) {
    throw new Error('Capsule no longer matches the validated restore plan.');
  }
  if (await pathExists(plan.destination)) throw new Error(`Destination must not exist: ${plan.destination}`);
  if (await pathExists(plan.claudeDestination)) {
    throw new Error(`Claude destination must not exist: ${plan.claudeDestination}`);
  }
  const receiptPath = await resolveCapsuleOperationPath({
    capsule: planCapsule,
    requested: receiptInput,
    filename: `${plan.planId}.receipt.json`,
  });
  if (!receiptPath.endsWith('.json')) throw new Error('Restore receipt filename must end with .json.');
  const receiptBase = receiptPath.endsWith('.json') ? receiptPath.slice(0, -'.json'.length) : receiptPath;
  const receiptMarkdownPath = await resolveCapsuleOperationPath({
    capsule: planCapsule,
    requested: `${receiptBase}.md`,
    filename: `${plan.planId}.receipt.md`,
  });
  const receiptHtmlPath = await resolveCapsuleOperationPath({
    capsule: planCapsule,
    requested: `${receiptBase}.html`,
    filename: `${plan.planId}.receipt.html`,
  });
  if (pathsOverlap(receiptPath, plan.destination)) {
    throw new Error('Receipt path must be outside the restored project.');
  }
  if (pathsOverlap(receiptPath, plan.claudeDestination)) {
    throw new Error('Receipt path must be outside the restored Claude home.');
  }
  const manifest = await readJson(path.join(planCapsule, 'manifest.json'));
  const effectiveEntries = restorableEntries(manifest);
  const sessionCatalog = await readJson(path.join(planCapsule, 'sessions.json'));
  const gitApplicable = capsuleUsesGit(manifest);
  const git = gitApplicable
    ? await probeGit(plan.git?.path ?? manifest.git.prerequisite.path)
    : null;
  const parent = path.dirname(plan.destination);
  const claudeParent = path.dirname(plan.claudeDestination);
  await ensureDirectory(parent, 'Destination parent');
  await ensureDirectory(claudeParent, 'Claude destination parent');
  const currentProbe = await probeFilesystem(parent);
  const currentClaudeProbe = await probeFilesystem(claudeParent);
  if (!currentProbe.capabilities.atomicRename) {
    throw new Error('Destination no longer passes the atomic rename capability probe.');
  }
  if (!currentProbe.capabilities.symlink && effectiveEntries.repository.some((entry) => entry.kind === 'symlink')) {
    throw new Error('Destination no longer supports required symbolic links.');
  }
  if (!currentClaudeProbe.capabilities.atomicRename) {
    throw new Error('Claude destination no longer passes the atomic rename capability probe.');
  }
  if (!currentClaudeProbe.capabilities.symlink && effectiveEntries.agent.some((entry) => entry.kind === 'symlink')) {
    throw new Error('Claude destination no longer supports required symbolic links.');
  }
  const staging = path.join(parent, `.claude-replicant-restore-${manifest.packageId}-${randomUUID()}`);
  const claudeStaging = path.join(
    claudeParent,
    `.claude-replicant-claude-restore-${manifest.packageId}-${randomUUID()}`,
  );
  const restoreLockPath = path.join(
    parent,
    `.claude-replicant-lock-${digestObject(plan.destination).slice(0, 20)}`,
  );
  const restoreLock = await open(restoreLockPath, 'wx', 0o600).catch((error) => {
    throw new Error(`Another restore may be targeting this destination (${restoreLockPath}): ${error.message}`);
  });
  let lockReleased = false;
  async function releaseRestoreLock() {
    if (lockReleased) return;
    lockReleased = true;
    await restoreLock.close();
    await unlink(restoreLockPath).catch(() => {});
  }
  const variances = [...plan.declaredVariances];
  const startedAt = isoNow();
  const mappedAgentEntries = effectiveEntries.agent.map((entry) => ({
    ...entry,
    sourceLogicalPath: entry.logicalPath,
    logicalPath: restoredClaudeLogicalPath(entry.logicalPath, manifest.agentState.projectKey, plan.destination),
  }));

  await mkdir(staging, { mode: 0o700 });
  await mkdir(claudeStaging, { mode: 0o700 });
  try {
    await applyTreeEntries({ capsule: planCapsule, staging, entries: effectiveEntries.repository, variances });
    await applyTreeEntries({ capsule: planCapsule, staging: claudeStaging, entries: mappedAgentEntries, variances });

    const treeVerification = await verifyTree(staging, effectiveEntries.repository);
    if (!treeVerification.valid) {
      throw new Error(`Restored tree verification failed: ${JSON.stringify(treeVerification.errors)}`);
    }
    const gitVerification = gitApplicable
      ? await verifyGitAfterRestore({ destination: staging, manifest, git })
      : notApplicableGitVerification();
    if (!gitVerification.valid) {
      throw new Error(`Restored Git verification failed: ${JSON.stringify(gitVerification.mismatches)}`);
    }
    const agentSourceVerification = await verifyTree(claudeStaging, mappedAgentEntries);
    if (!agentSourceVerification.valid) {
      throw new Error(`Captured Claude state verification failed: ${JSON.stringify(agentSourceVerification.errors)}`);
    }
    const pathRemap = await remapRestoredClaudeState({
      claudeRoot: claudeStaging,
      entries: mappedAgentEntries,
      oldProjectKey: manifest.agentState.projectKey,
      sourceProjectPath: manifest.agentState.sourceProjectPath,
      destinationProjectPath: plan.destination,
      variances,
    });
    const agentVerification = await verifyTree(claudeStaging, pathRemap.runtimeEntries);
    if (!agentVerification.valid) {
      throw new Error(`Path-remapped Claude state verification failed: ${JSON.stringify(agentVerification.errors)}`);
    }
    const nativeResumeReadiness = await verifyRestoredClaudeSessions({
      claudeRoot: claudeStaging,
      destinationProjectPath: plan.destination,
      sessions: sessionCatalog.sessions,
    });
    if (!nativeResumeReadiness.valid) {
      throw new Error(`Restored sessions do not satisfy Claude Code resume layout: ${JSON.stringify(nativeResumeReadiness.sessions)}`);
    }
    if (await pathExists(plan.destination) || await pathExists(plan.claudeDestination)) {
      throw new Error('A restore destination appeared during restore; refusing finalization.');
    }
    await rename(claudeStaging, plan.claudeDestination);
    try {
      await rename(staging, plan.destination);
    } catch (error) {
      await rename(plan.claudeDestination, claudeStaging).catch(() => {});
      throw error;
    }
    const postRenameTree = await verifyTree(plan.destination, effectiveEntries.repository);
    const postRenameGit = gitApplicable
      ? await verifyGitAfterRestore({ destination: plan.destination, manifest, git })
      : notApplicableGitVerification();
    const postRenameAgent = await verifyTree(plan.claudeDestination, pathRemap.runtimeEntries);
    if (!postRenameTree.valid || !postRenameGit.valid || !postRenameAgent.valid) {
      throw new Error('Post-rename verification failed; restored destination retained for diagnosis.');
    }
    const receipt = {
      schemaVersion: FORMAT_VERSION,
      receiptId: newId('receipt'),
      planId: plan.planId,
      planDigest: plan.planDigest,
      capsuleId: manifest.packageId,
      manifestDigest: manifest.manifestDigest,
      sourceKind: manifest.source?.kind ?? GIT_SOURCE_KIND,
      destination: plan.destination,
      claudeDestination: plan.claudeDestination,
      activation: plan.activation,
      startedAt,
      completedAt: isoNow(),
      approved: true,
      result: 'restored-and-verified',
      treeVerification: postRenameTree,
      gitVerification: postRenameGit,
      agentStateVerification: postRenameAgent,
      capturedAgentStateVerification: agentSourceVerification,
      pathRemap: {
        sourceProjectPath: pathRemap.sourceProjectPath,
        destinationProjectPath: pathRemap.destinationProjectPath,
        sourceProjectKey: pathRemap.oldProjectKey,
        destinationProjectKey: pathRemap.destinationProjectKey,
        remappedFiles: pathRemap.remapped,
      },
      nativeResumeReadiness,
      resume: {
        workingDirectory: plan.destination,
        environment: { CLAUDE_CONFIG_DIR: plan.claudeDestination },
        pickerCommand: 'claude --resume',
        sessions: sessionCatalog.sessions.map((session) => ({
          sessionId: session.sessionId,
          title: session.title,
          command: session.resumeCommand,
        })),
      },
      declaredVariances: variances,
      limitations: [
        'Dedicated credential stores, dependencies, xattrs, ACLs, BSD flags, ownership, and birthtime were not restored.',
      ],
      reports: {
        json: receiptPath,
        markdown: receiptMarkdownPath,
        html: receiptHtmlPath,
      },
    };
    await writeJsonAtomic(receiptPath, receipt);
    await writeTextAtomic(receiptMarkdownPath, restoreMarkdown(receipt));
    await writeTextAtomic(receiptHtmlPath, restoreHtml(receipt));
    await releaseRestoreLock();
    return { ...receipt, receiptPath };
  } catch (error) {
    if (await pathExists(staging)) await cleanup(staging);
    if (await pathExists(claudeStaging)) await cleanup(claudeStaging);
    await releaseRestoreLock();
    throw error;
  }
}
