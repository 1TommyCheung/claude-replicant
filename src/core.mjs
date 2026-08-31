import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  link,
} from 'node:fs/promises';
import path from 'node:path';
import {
  applyFileMetadata,
  captureTree,
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
  'agent-environment-profile.json',
  'redaction-report.json',
  'restore-readiness.json',
];

function defaultAgentEnvironmentProfile() {
  return {
    schemaVersion: '1.0.0',
    collectionStatus: 'deferred',
    collectionPolicy: 'project-scoped-only',
    projectScoped: [],
    userGlobal: [],
    findings: [
      {
        code: 'agent-environment-analysis-deferred',
        message: 'Part 1 does not inspect Claude/Codex skills, MCP configuration, or agent state.',
      },
    ],
  };
}

function readinessFrom({ capture, gitLayout, gitStable, filesystemProbe }) {
  const repoFindings = capture.findings.filter((finding) =>
    ['source-changed-during-capture', 'special-file-not-captured'].includes(finding.code));
  const gitFindings = [
    ...gitLayout.pathBound.map((binding) => ({
      code: `git-path-bound:${binding.kind}`,
      severity: 'blocker',
    })),
    ...capture.findings.filter((finding) => finding.code === 'git-lock-present'),
    ...(gitStable ? [] : [{ code: 'git-state-changed-during-capture', severity: 'blocker' }]),
  ];
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
      status: gitFindings.length === 0 && gitLayout.actualRestoreSupported ? 'ready' : 'not-ready',
      findings: gitFindings,
    },
    filesystemMetadata: { status: 'action-required', findings: metadataFindings },
    agentState: {
      status: 'action-required',
      findings: [{ code: 'agent-state-not-implemented', severity: 'action-required' }],
    },
    agentEnvironment: {
      status: 'action-required',
      findings: [{ code: 'agent-environment-deferred', severity: 'action-required' }],
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
      'Credential and agent-state capture are intentionally outside Part 1.',
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
  return [
    '# Claude Replicant Capture Report',
    '',
    `- Capsule: ${report.packageId}`,
    `- Source label: ${report.sourceLabel}`,
    `- Captured: ${report.createdAt}`,
    `- Included entries: ${report.totals.entries}`,
    `- Included bytes: ${report.totals.bytes}`,
    `- Credential exclusions: ${report.totals.secretExclusions}`,
    `- Overall readiness: ${report.readiness}`,
    '',
    '> SECRET-BEARING: Treat this capsule and its store as confidential.',
    '',
    'Claude/Codex agent state, user-global configuration, credentials, and semantic analysis are not included in Part 1.',
    '',
  ].join('\n');
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

async function initializeStore(store) {
  await mkdir(store, { recursive: true, mode: 0o700 });
  const storeFile = path.join(store, 'store.json');
  if (await pathExists(storeFile)) {
    const current = await readJson(storeFile);
    if (current.schemaVersion !== FORMAT_VERSION) {
      throw new Error(`Unsupported capsule store version ${current.schemaVersion}.`);
    }
  } else {
    await writeJsonAtomic(storeFile, {
      schemaVersion: FORMAT_VERSION,
      storeId: newId('store'),
      createdAt: isoNow(),
    });
  }
  await mkdir(path.join(store, 'capsules'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(store, 'derivatives'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(store, 'receipts'), { recursive: true, mode: 0o700 });
}

async function appendCatalog(store, manifest) {
  const catalog = path.join(store, 'catalog.jsonl');
  const current = (await pathExists(catalog)) ? await readFile(catalog, 'utf8') : '';
  const next = `${current}${JSON.stringify({
    packageId: manifest.packageId,
    createdAt: manifest.createdAt,
    sourceLabel: manifest.source.label,
    manifestDigest: manifest.manifestDigest,
    readiness: manifest.readiness.overall,
    relativePath: `capsules/${manifest.packageId}`,
  })}\n`;
  await writeTextAtomic(catalog, next);
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
    throw new Error('Source repository and capsule store must not overlap.');
  }
  return { source, store };
}

export async function previewCapture({ source: sourceInput, store: storeInput, gitPath = 'git' }) {
  assertNodeVersion();
  if (!sourceInput || !storeInput) throw new Error('Capture requires explicit --source and --store paths.');
  const { source, store } = await resolveSourceAndStore(sourceInput, storeInput);
  const git = await probeGit(gitPath);
  const gitLayout = await inspectGitLayout(source);
  const candidates = await walkTree(source);
  if (!gitLayout.actualRestoreSupported) {
    return {
      mode: 'preview',
      source,
      store,
      candidateEntries: candidates.length,
      git: { ...git, layout: gitLayout.layout, pathBound: gitLayout.pathBound },
      blockers: [{ code: 'git-layout-unsupported-for-part1', findings: gitLayout.pathBound }],
      warnings: ['No files were written. Part 1 capture cannot proceed for this Git layout.'],
    };
  }
  const gitSnapshot = await captureGitSnapshot(source, git);
  return {
    mode: 'preview',
    source,
    store,
    candidateEntries: candidates.length,
    git: {
      ...git,
      layout: gitLayout.layout,
      pathBound: gitLayout.pathBound,
      head: gitSnapshot.head,
      symbolicHead: gitSnapshot.symbolicHead,
    },
    warnings: [
      'No files were written. Re-run with --confirm to create a capsule.',
      'Known credential files are excluded; tracked credential material blocks capture.',
      'Part 1 captures selected repository data only, not Claude/Codex agent state.',
    ],
  };
}

export async function captureRepository({
  source: sourceInput,
  store: storeInput,
  gitPath = 'git',
  confirm = false,
  maxEntries,
  maxBytes,
  beforeTreeCapture,
}) {
  if (!confirm) return previewCapture({ source: sourceInput, store: storeInput, gitPath });
  assertNodeVersion();
  const { source, store } = await resolveSourceAndStore(sourceInput, storeInput, { createStore: true });
  await initializeStore(store);
  const storeProbe = await probeFilesystem(store);
  if (!storeProbe.capabilities.atomicRename) {
    throw new Error('Destination store failed the atomic rename capability probe.');
  }
  const git = await probeGit(gitPath);
  const gitLayout = await inspectGitLayout(source);
  if (!gitLayout.actualRestoreSupported) {
    throw new Error(`Part 1 does not support this Git layout: ${JSON.stringify(gitLayout.pathBound)}`);
  }
  const gitBefore = await captureGitSnapshot(source, git);
  const sourceCandidates = await walkTree(source);
  const storeCollisions = collisionFindings(sourceCandidates, storeProbe);
  if (storeCollisions.length > 0) {
    throw new Error(`Destination store cannot represent source filenames: ${JSON.stringify(storeCollisions)}`);
  }
  const packageId = newId('capsule');
  const staging = path.join(store, 'capsules', `.staging-${packageId}`);
  const finalPath = path.join(store, 'capsules', packageId);
  const payloadRoot = path.join(staging, 'payload', 'repository');
  const startedAt = isoNow();
  await mkdir(payloadRoot, { recursive: true, mode: 0o700 });

  try {
    if (beforeTreeCapture) await beforeTreeCapture({ source, store, packageId });
    const captured = await captureTree({
      source,
      payloadRoot,
      trackedPaths: gitBefore.trackedPaths,
      maxEntries,
      maxBytes,
    });
    if (captured.totals.unstableEntries > 0) {
      throw new Error('Source changed during capture; quiesce the repository and retry.');
    }
    const gitAfter = await captureGitSnapshot(source, git);
    const gitStable = gitBefore.snapshotDigest === gitAfter.snapshotDigest;
    const excludedPaths = captured.inventory
      .filter((record) => record.decision === 'excluded' && record.sensitivity === 'credential')
      .map((record) => record.logicalPath);
    const expectedGitBefore = filterStatusForPolicyExclusions(comparableGitSnapshot(gitBefore), excludedPaths);
    const expectedGitAfter = filterStatusForPolicyExclusions(comparableGitSnapshot(gitAfter), excludedPaths);
    const readiness = readinessFrom({ capture: captured, gitLayout, gitStable, filesystemProbe: storeProbe });
    const agentEnvironment = defaultAgentEnvironmentProfile();
    const report = {
      schemaVersion: FORMAT_VERSION,
      packageId,
      createdAt: isoNow(),
      captureWindow: { startedAt, endedAt: isoNow() },
      sourceLabel: path.basename(source),
      totals: captured.totals,
      readiness: readiness.overall,
      agentEnvironmentStatus: agentEnvironment.collectionStatus,
      warnings: readiness.warnings,
    };
    const redaction = {
      schemaVersion: FORMAT_VERSION,
      credentialFilesExcluded: captured.totals.secretExclusions,
      valuesPersisted: false,
      findings: captured.findings.filter((finding) => finding.code === 'credential-excluded'),
    };

    await writeTextAtomic(
      path.join(staging, 'inventory.jsonl'),
      `${captured.inventory.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    await writeJson(path.join(staging, 'capture-report.json'), report);
    await writeTextAtomic(path.join(staging, 'capture-report.md'), captureMarkdown(report));
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
        absolutePathStored: false,
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
        scope: 'selected-repository-only',
        credentials: 'excluded-no-encryption-envelope',
        agentState: 'not-captured',
        repositoryCodeExecution: 'forbidden',
        limits: {
          maxEntries: maxEntries ?? 100_000,
          maxBytes: maxBytes ?? 5 * 1024 * 1024 * 1024,
        },
      },
      git: {
        prerequisite: git,
        layout: gitLayout,
        before: expectedGitBefore,
        after: expectedGitAfter,
        stable: gitStable,
        reconstruction: 'byte-for-byte-dot-git-and-index',
      },
      entries: captured.entries,
      findings: captured.findings,
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
    await appendCatalog(store, manifest);
    return {
      mode: 'captured',
      capsulePath: finalPath,
      packageId,
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

  const seen = new Set();
  for (const entry of manifest.entries ?? []) {
    if (seen.has(entry.logicalPath)) {
      errors.push({ code: 'duplicate-logical-path', path: entry.logicalPath });
      continue;
    }
    seen.add(entry.logicalPath);
    let payload;
    try {
      payload = safeJoin(capsule, entry.payloadPath);
    } catch (error) {
      errors.push({ code: 'unsafe-payload-path', path: entry.logicalPath, message: error.message });
      continue;
    }
    const stats = await lstat(payload).catch(() => null);
    if (!stats) {
      errors.push({ code: 'missing-payload', path: entry.logicalPath });
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

  const payloadRoot = path.join(capsule, 'payload', 'repository');
  if (await pathExists(payloadRoot)) {
    const payloadEntries = (await walkTree(payloadRoot)).map((entry) => entry.logicalPath);
    for (const extra of payloadEntries) {
      if (!seen.has(extra)) errors.push({ code: 'unreferenced-payload', path: extra });
    }
  } else {
    errors.push({ code: 'missing-payload-root' });
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

export async function createRestorePlan({ capsule: capsuleInput, destination: destinationInput }) {
  assertNodeVersion();
  if (!capsuleInput || !destinationInput) throw new Error('Plan requires --capsule and --destination.');
  const capsule = await resolveExistingDirectory(path.resolve(capsuleInput), 'Capsule');
  const destination = path.resolve(destinationInput);
  if (pathsOverlap(capsule, destination)) throw new Error('Capsule and restore destination must not overlap.');
  const validation = await validateCapsule(capsule);
  const manifest = await readJson(path.join(capsule, 'manifest.json'));
  const blockers = [];
  if (!validation.valid) blockers.push({ code: 'capsule-invalid', errors: validation.errors });
  if (manifest.readiness.domains.repositoryData.status === 'not-ready') {
    blockers.push({ code: 'repository-data-not-ready' });
  }
  if (manifest.readiness.domains.gitState.status !== 'ready') {
    blockers.push({ code: 'git-state-not-ready', findings: manifest.readiness.domains.gitState.findings });
  }
  const git = await probeGit('git').catch((error) => {
    blockers.push({ code: 'git-prerequisite-unavailable', message: error.message });
    return null;
  });
  const probe = await destinationProbe(destination);
  if (!probe.capabilities.atomicRename) blockers.push({ code: 'destination-atomic-rename-unavailable' });
  if (!probe.capabilities.symlink && manifest.entries.some((entry) => entry.kind === 'symlink')) {
    blockers.push({ code: 'destination-symlink-unavailable' });
  }
  const destinationCollisions = collisionFindings(manifest.entries, probe);
  blockers.push(...destinationCollisions.map((finding) => ({
    code: `destination-${finding.code}`,
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
    ...manifest.entries
      .filter((entry) => (entry.metadata?.sourceSpecialMode ?? 0) !== 0)
      .map((entry) => ({
        code: 'metadata-variance:special-mode-bits-not-applied',
        path: entry.logicalPath,
        sourceSpecialMode: entry.metadata.sourceSpecialMode,
      })),
    ...manifest.entries
      .filter((entry) => entry.kind === 'symlink' && entry.targetClass !== 'relative-in-scope')
      .map((entry) => ({ code: 'symlink-portability-risk', path: entry.logicalPath, targetClass: entry.targetClass })),
  ];
  const operations = manifest.entries.map((entry) => ({
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
  const planWithoutDigest = {
    schema: RESTORE_PLAN_SCHEMA,
    planId: newId('plan'),
    createdAt: isoNow(),
    capsulePath: capsule,
    capsuleId: manifest.packageId,
    manifestDigest: manifest.manifestDigest,
    destination,
    runtime: { name: 'node', version: process.versions.node },
    git,
    destinationProbe: probe,
    validation,
    executable: blockers.length === 0,
    blockers,
    operations,
    declaredVariances: variances,
    approvalRequired: true,
  };
  return { ...planWithoutDigest, planDigest: digestObject(planWithoutDigest) };
}

function verifyPlanDigest(plan) {
  if (plan.schema !== RESTORE_PLAN_SCHEMA) throw new Error(`Unsupported restore plan schema: ${plan.schema}`);
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
  const expected = manifest.git.after;
  const actual = comparableGitSnapshot(snapshot);
  const fields = ['head', 'symbolicHead', 'refs', 'status', 'indexEntries', 'indexDigest'];
  const mismatches = fields
    .filter((field) => stableStringify(expected[field]) !== stableStringify(actual[field]))
    .map((field) => ({ field, expected: expected[field], actual: actual[field] }));
  return { valid: mismatches.length === 0, mismatches, snapshot: actual };
}

export async function restoreFromPlan({ plan: planInput, approve = false, receipt: receiptInput }) {
  assertNodeVersion();
  if (!approve) throw new Error('Actual restore requires explicit --approve.');
  const planPath = path.resolve(planInput);
  const plan = await readJson(planPath);
  verifyPlanDigest(plan);
  if (!plan.executable || plan.blockers.length > 0) {
    throw new Error(`Restore plan is not executable: ${JSON.stringify(plan.blockers)}`);
  }
  const validation = await validateCapsule(plan.capsulePath);
  if (!validation.valid || validation.manifestDigest !== plan.manifestDigest) {
    throw new Error('Capsule no longer matches the validated restore plan.');
  }
  if (await pathExists(plan.destination)) throw new Error(`Destination must not exist: ${plan.destination}`);
  const receiptPath = receiptInput
    ? path.resolve(receiptInput)
    : `${planPath}.receipt.json`;
  if (pathsOverlap(receiptPath, plan.destination)) {
    throw new Error('Receipt path must be outside the restored repository.');
  }
  const manifest = await readJson(path.join(plan.capsulePath, 'manifest.json'));
  const git = await probeGit(plan.git?.path ?? manifest.git.prerequisite.path);
  const parent = path.dirname(plan.destination);
  await ensureDirectory(parent, 'Destination parent');
  const currentProbe = await probeFilesystem(parent);
  if (!currentProbe.capabilities.atomicRename) {
    throw new Error('Destination no longer passes the atomic rename capability probe.');
  }
  if (!currentProbe.capabilities.symlink && manifest.entries.some((entry) => entry.kind === 'symlink')) {
    throw new Error('Destination no longer supports required symbolic links.');
  }
  const staging = path.join(parent, `.claude-replicant-restore-${manifest.packageId}-${randomUUID()}`);
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
  const hardlinks = new Map();
  const startedAt = isoNow();

  await mkdir(staging, { mode: 0o700 });
  try {
    const directories = manifest.entries.filter((entry) => entry.kind === 'directory');
    const nonDirectories = manifest.entries.filter((entry) => entry.kind !== 'directory');
    for (const entry of directories) await applyEntry({ capsule: plan.capsulePath, staging, entry, hardlinks, variances });
    for (const entry of nonDirectories) await applyEntry({ capsule: plan.capsulePath, staging, entry, hardlinks, variances });
    for (const entry of [...directories].sort((a, b) => b.logicalPath.length - a.logicalPath.length)) {
      await applyFileMetadata(safeJoin(staging, entry.logicalPath), entry, variances);
    }

    const treeVerification = await verifyTree(staging, manifest.entries);
    if (!treeVerification.valid) {
      throw new Error(`Restored tree verification failed: ${JSON.stringify(treeVerification.errors)}`);
    }
    const gitVerification = await verifyGitAfterRestore({ destination: staging, manifest, git });
    if (!gitVerification.valid) {
      throw new Error(`Restored Git verification failed: ${JSON.stringify(gitVerification.mismatches)}`);
    }
    if (await pathExists(plan.destination)) {
      throw new Error(`Destination appeared during restore; refusing finalization: ${plan.destination}`);
    }
    await rename(staging, plan.destination);
    const postRenameTree = await verifyTree(plan.destination, manifest.entries);
    const postRenameGit = await verifyGitAfterRestore({ destination: plan.destination, manifest, git });
    if (!postRenameTree.valid || !postRenameGit.valid) {
      throw new Error('Post-rename verification failed; restored destination retained for diagnosis.');
    }
    const receipt = {
      schemaVersion: FORMAT_VERSION,
      receiptId: newId('receipt'),
      planId: plan.planId,
      planDigest: plan.planDigest,
      capsuleId: manifest.packageId,
      manifestDigest: manifest.manifestDigest,
      destination: plan.destination,
      startedAt,
      completedAt: isoNow(),
      approved: true,
      result: 'restored-and-verified',
      treeVerification: postRenameTree,
      gitVerification: postRenameGit,
      declaredVariances: variances,
      limitations: [
        'Agent state, credentials, dependencies, xattrs, ACLs, BSD flags, ownership, and birthtime were not restored.',
      ],
    };
    await writeJsonAtomic(receiptPath, receipt);
    await releaseRestoreLock();
    return { ...receipt, receiptPath };
  } catch (error) {
    if (await pathExists(staging)) await cleanup(staging);
    await releaseRestoreLock();
    throw error;
  }
}
