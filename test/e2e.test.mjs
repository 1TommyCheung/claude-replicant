import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  appendFile,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  captureRepository,
  createRestorePlan,
  restoreFromPlan,
  validateCapsule,
} from '../src/core.mjs';
import { previewClaudeState } from '../src/claude-state.mjs';
import { digestObject, readJson, sha256File, writeJsonAtomic } from '../src/util.mjs';

const execFileAsync = promisify(execFile);

async function git(repository, args) {
  const result = await execFileAsync('git', args, {
    cwd: repository,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function waitFor(filePath, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await lstat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`helper exited ${child.exitCode}`));
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`helper exited ${code}`)));
  });
}

async function createFixture(root) {
  const repository = path.join(root, 'source-project');
  await mkdir(repository, { recursive: true });
  await git(repository, ['init', '-b', 'migration-fixture']);
  await git(repository, ['config', 'user.name', 'Fixture User']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);

  await mkdir(path.join(repository, 'src'), { recursive: true });
  await mkdir(path.join(repository, 'generated'), { recursive: true });
  await writeFile(path.join(repository, '.gitignore'), '.env\ngenerated/\n');
  await writeFile(path.join(repository, 'README.md'), '# Fixture\nDeclares ExampleWeather API.\n');
  await writeFile(path.join(repository, 'AGENTS.md'), 'Use project skill fixture-review.\n');
  await writeFile(path.join(repository, 'CLAUDE.md'), 'Configured MCP: fixture-mcp.\n');
  await writeFile(path.join(repository, 'MEMORY.md'), 'Project-scoped synthetic memory only.\n');
  await writeFile(path.join(repository, 'src', 'work.txt'), 'base\n');
  await writeFile(path.join(repository, 'unicodé-測試.txt'), 'unicode\n');
  await writeFile(path.join(repository, 'hardlink-a.txt'), 'hardlink\n');
  await mkdir(path.join(repository, '.tracked'), { recursive: true });
  await writeFile(path.join(repository, '.tracked', '.DS_Store'), 'tracked repository metadata\n');
  await link(path.join(repository, 'hardlink-a.txt'), path.join(repository, 'hardlink-b.txt'));
  await symlink('src/work.txt', path.join(repository, 'relative-link'));
  await symlink('/tmp/claude-replicant-outside', path.join(repository, 'absolute-link'));
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture baseline']);

  await writeFile(path.join(repository, 'src', 'work.txt'), 'staged\n');
  await git(repository, ['add', 'src/work.txt']);
  await appendFile(path.join(repository, 'src', 'work.txt'), 'unstaged\n');
  await writeFile(path.join(repository, 'untracked-notes.txt'), 'untracked\n');
  await writeFile(path.join(repository, '.DS_Store'), 'repository finder metadata\n');
  await writeFile(path.join(repository, 'generated', 'output.txt'), 'ignored generated\n');
  await writeFile(path.join(repository, '.env'), 'API_KEY=fake_fixture_secret_123456789\n');

  await mkdir(path.join(repository, '.claude', 'project'), { recursive: true });
  await writeFile(
    path.join(repository, '.claude', 'project', 'memory.json'),
    `${JSON.stringify({ project: 'fixture', purpose: 'synthetic-only' })}\n`,
  );
  const session = path.join(repository, '.claude', 'project', 'session.jsonl');
  const seedLine = `${JSON.stringify({ event: 'seed', model: 'claude-fixture-model' })}\n`;
  await writeFile(session, seedLine.repeat(350_000));
  const executionMarker = path.join(root, 'repository-code-executed');
  const hostileHelper = path.join(repository, '.git', 'hostile-fsmonitor.sh');
  await writeFile(hostileHelper, `#!/bin/sh\ntouch ${JSON.stringify(executionMarker)}\nexit 1\n`);
  await chmod(hostileHelper, 0o700);
  await writeFile(
    path.join(repository, '.git', 'hooks', 'post-checkout'),
    `#!/bin/sh\ntouch ${JSON.stringify(executionMarker)}\n`,
  );
  await chmod(path.join(repository, '.git', 'hooks', 'post-checkout'), 0o700);
  await git(repository, ['config', 'core.fsmonitor', hostileHelper]);

  const claudeHome = path.join(root, '.claude');
  const projectKey = path.resolve(repository).replaceAll(path.sep, '-');
  const claudeProject = path.join(claudeHome, 'projects', projectKey);
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const secondSessionId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  await mkdir(path.join(claudeProject, sessionId, 'subagents'), { recursive: true });
  await mkdir(path.join(claudeProject, 'memory'), { recursive: true });
  await mkdir(path.join(claudeHome, 'agents'), { recursive: true });
  await mkdir(path.join(claudeHome, 'skills', 'fixture-skill'), { recursive: true });
  await mkdir(path.join(claudeHome, 'plans'), { recursive: true });
  const pluginNodeModules = path.join(
    claudeHome,
    'plugins',
    'cache',
    'claude-plugins-official',
    'chrome-devtools-mcp',
    '1.7.0',
    'node_modules',
  );
  await mkdir(pluginNodeModules, { recursive: true });
  await writeFile(path.join(claudeHome, 'CLAUDE.md'), 'Global Claude instructions.\n');
  await writeFile(path.join(claudeHome, 'settings.json'), '{"theme":"dark"}\n');
  await writeFile(path.join(claudeHome, '.claude.json'), '{"shadowConfig":"must-not-win"}\n');
  await writeFile(path.join(claudeHome, '.credentials.json'), '{"token":"must-not-copy"}\n');
  await writeFile(path.join(root, '.claude.json'), '{"projects":{"fixture":{"mcpServers":{}}}}\n');
  await writeFile(path.join(claudeHome, 'agents', 'reviewer.md'), 'Review agent.\n');
  await writeFile(path.join(claudeHome, 'skills', 'fixture-skill', 'SKILL.md'), 'Fixture skill.\n');
  await writeFile(path.join(claudeHome, 'plans', 'fixture-plan.md'), 'Project plan.\n');
  await writeFile(path.join(claudeHome, '.DS_Store'), 'claude finder metadata\n');
  await writeFile(path.join(claudeHome, 'plugins', '.DS_Store'), 'plugins finder metadata\n');
  await writeFile(path.join(claudeHome, 'plugins', 'cache', '.DS_Store'), 'cache finder metadata\n');
  await writeFile(path.join(pluginNodeModules, '.DS_Store'), 'node modules finder metadata\n');
  await writeFile(path.join(pluginNodeModules, 'fixture-package.json'), '{}\n');
  await writeFile(path.join(claudeProject, 'memory', 'MEMORY.md'), 'Remember the migration goal.\n');
  const claudeSession = path.join(claudeProject, `${sessionId}.jsonl`);
  const sessionRecord = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    timestamp: '2026-08-31T12:00:00.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: repository,
    sessionId,
    version: '2.1.250',
    gitBranch: 'migration-fixture',
    message: { role: 'user', content: 'Capture everything and preserve this session.' },
  };
  await writeFile(
    claudeSession,
    `${JSON.stringify(sessionRecord)}\n`.repeat(30_000),
  );
  await writeFile(
    path.join(claudeProject, `${secondSessionId}.jsonl`),
    `${JSON.stringify({
      ...sessionRecord,
      uuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      timestamp: '2026-08-31T13:00:00.000Z',
      sessionId: secondSessionId,
      entrypoint: 'agent-sdk',
      message: { role: 'user', content: 'Continue the second captured session.' },
    })}\n`,
  );
  await writeFile(
    path.join(claudeProject, sessionId, 'subagents', 'agent-review.jsonl'),
    `${JSON.stringify({ type: 'assistant', sessionId, result: 'reviewed' })}\n`,
  );
  return { repository, session, claudeSession, claudeHome, sessionId, secondSessionId, executionMarker };
}

test('Part 1 captures, validates, rejects corruption, plans, restores, and verifies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-replicant-e2e-'));
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });
  const { repository, claudeSession, claudeHome, sessionId, secondSessionId, executionMarker } = await createFixture(root);
  const store = path.join(root, 'capsule-store');

  await assert.rejects(
    captureRepository({
      source: repository,
      store,
      claudeHome,
      gitPath: path.join(root, 'git-is-not-installed'),
      confirm: false,
    }),
    /Git is required/,
  );

  const preview = await captureRepository({ source: repository, store, claudeHome, confirm: false });
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.sourceKind, 'git-repository');
  assert.equal(preview.git.applicable, true);
  assert.equal(preview.claudeState.sessionCount, 2);
  await assert.rejects(lstat(store));

  const startSignal = path.join(root, 'writer-start');
  const readySignal = path.join(root, 'writer-ready');
  const writer = spawn(process.execPath, [
    path.join(import.meta.dirname, 'helper-live-writer.mjs'),
    claudeSession,
    startSignal,
    readySignal,
  ], { stdio: 'inherit' });

  const captured = await captureRepository({
    source: repository,
    store,
    claudeHome,
    confirm: true,
    beforeTreeCapture: async () => {
      await writeFile(startSignal, 'start\n');
      await waitFor(readySignal);
    },
  });
  await waitForExit(writer);
  assert.equal(captured.mode, 'captured');
  assert.equal(captured.sourceKind, 'git-repository');
  assert.equal(captured.validation.valid, true);
  assert.equal(captured.capsulePath, path.join(store, 'capsule', captured.packageId));
  await assert.rejects(lstat(path.join(store, 'capsules')));
  assert.deepEqual(await readdir(store), ['capsule']);
  assert.deepEqual(await readdir(path.join(store, 'capsule')), [captured.packageId]);
  assert.equal((await lstat(path.join(captured.capsulePath, 'operations'))).isDirectory(), true);
  await assert.rejects(lstat(path.join(store, 'store.json')));
  await assert.rejects(lstat(path.join(store, 'catalog.jsonl')));
  await assert.rejects(lstat(path.join(store, 'derivatives')));
  await assert.rejects(lstat(path.join(store, 'receipts')));
  await assert.rejects(lstat(executionMarker));

  const validation = await validateCapsule(captured.capsulePath);
  assert.equal(validation.valid, true);
  const cliValidation = await execFileAsync(process.execPath, [
    path.join(import.meta.dirname, '..', 'scripts', 'claude-replicant.mjs'),
    'validate',
    '--capsule',
    captured.capsulePath,
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(JSON.parse(cliValidation.stdout).valid, true);
  const manifest = await readJson(path.join(captured.capsulePath, 'manifest.json'));
  assert.equal(manifest.source.kind, 'git-repository');
  assert.equal(manifest.git.applicable, true);
  assert.ok(manifest.findings.some((finding) => finding.code === 'credential-excluded'));
  assert.ok(manifest.findings.some((finding) => finding.code === 'live-append-stable-prefix'));
  assert.equal(manifest.readiness.domains.repositoryData.status, 'ready');
  assert.equal(manifest.readiness.domains.gitState.status, 'ready');
  assert.equal(manifest.readiness.domains.agentState.status, 'ready');
  assert.equal(manifest.policy.agentState, 'captured-with-execution-as-authorization');
  assert.equal(manifest.agentState.adapterVersion, '1.1.1');
  assert.ok(manifest.agentState.entries.some((entry) => entry.logicalPath.endsWith(`${sessionId}.jsonl`)));
  assert.ok(manifest.agentState.entries.some((entry) => entry.logicalPath.endsWith('memory/MEMORY.md')));
  assert.ok(manifest.agentState.entries.some((entry) => entry.logicalPath === 'agents/reviewer.md'));
  assert.equal(manifest.entries.some((entry) => entry.logicalPath === '.DS_Store'), false);
  assert.equal(manifest.entries.some((entry) => entry.logicalPath === '.tracked/.DS_Store'), true);
  assert.equal(manifest.agentState.entries.some((entry) => entry.logicalPath.endsWith('.DS_Store')), false);
  assert.equal(manifest.agentState.entries.filter((entry) => entry.logicalPath === '.claude.json').length, 1);
  assert.equal(
    await readFile(path.join(captured.capsulePath, 'payload', 'claude-home', '.claude.json'), 'utf8'),
    '{"projects":{"fixture":{"mcpServers":{}}}}\n',
  );
  assert.equal(await lstat(path.join(captured.capsulePath, 'capture-report.html')).then(() => true), true);
  await assert.rejects(lstat(path.join(captured.capsulePath, 'payload', 'claude-home', '.credentials.json')));
  const sessionsReport = await readJson(path.join(captured.capsulePath, 'sessions.json'));
  assert.equal(sessionsReport.total, 2);
  assert.equal(sessionsReport.directlyResumable, 2);
  assert.deepEqual(
    new Set(sessionsReport.sessions.map((sessionEntry) => sessionEntry.sessionId)),
    new Set([sessionId, secondSessionId]),
  );
  assert.match(sessionsReport.sessions.find((sessionEntry) => sessionEntry.sessionId === sessionId).title, /Capture everything/);
  const captureReport = await readJson(path.join(captured.capsulePath, 'capture-report.json'));
  assert.deepEqual(
    new Set(captureReport.sessions.map((sessionEntry) => sessionEntry.sessionId)),
    new Set([sessionId, secondSessionId]),
  );
  assert.match(await readFile(path.join(captured.capsulePath, 'capture-report.md'), 'utf8'), new RegExp(sessionId));
  assert.match(await readFile(path.join(captured.capsulePath, 'capture-report.md'), 'utf8'), new RegExp(secondSessionId));
  assert.match(await readFile(path.join(captured.capsulePath, 'capture-report.html'), 'utf8'), new RegExp(sessionId));
  assert.match(await readFile(path.join(captured.capsulePath, 'capture-report.html'), 'utf8'), new RegExp(secondSessionId));

  const inventoryText = await readFile(path.join(captured.capsulePath, 'inventory.jsonl'), 'utf8');
  assert.match(inventoryText, /credential-filename-policy/);
  assert.match(inventoryText, /platform-metadata-policy/);
  assert.doesNotMatch(inventoryText, /fake_fixture_secret_123456789/);
  await assert.rejects(lstat(path.join(captured.capsulePath, 'payload', 'repository', '.DS_Store')));
  await assert.rejects(lstat(path.join(captured.capsulePath, 'payload', 'claude-home', '.DS_Store')));

  const finderMetadataPaths = [
    '.DS_Store',
    'plugins/.DS_Store',
    'plugins/cache/.DS_Store',
    'plugins/cache/claude-plugins-official/chrome-devtools-mcp/1.7.0/node_modules/.DS_Store',
  ];
  for (const logicalPath of finderMetadataPaths) {
    await writeFile(
      path.join(captured.capsulePath, 'payload', 'claude-home', ...logicalPath.split('/')),
      'post-capture finder metadata\n',
    );
  }
  const finderValidation = await validateCapsule(captured.capsulePath);
  assert.equal(finderValidation.valid, true);
  assert.deepEqual(
    finderValidation.warnings
      .filter((warning) => warning.code === 'ignored-unreferenced-platform-metadata')
      .map((warning) => warning.path),
    finderMetadataPaths,
  );

  const legacyCapsule = path.join(root, 'legacy-platform-metadata-capsule');
  await cp(captured.capsulePath, legacyCapsule, { recursive: true, verbatimSymlinks: true });
  const legacyManifestPath = path.join(legacyCapsule, 'manifest.json');
  const legacyManifest = await readJson(legacyManifestPath);
  const legacyPayloadPath = path.join(legacyCapsule, 'payload', 'repository', '.DS_Store');
  await writeFile(legacyPayloadPath, 'legacy captured finder metadata\n');
  const trackedMetadataEntry = legacyManifest.entries.find(
    (entry) => entry.logicalPath === '.tracked/.DS_Store',
  );
  legacyManifest.entries.push({
    ...structuredClone(trackedMetadataEntry),
    id: 'entry-legacy-platform-metadata',
    logicalPath: '.DS_Store',
    payloadPath: 'payload/repository/.DS_Store',
    tracked: false,
    sha256: await sha256File(legacyPayloadPath),
  });
  legacyManifest.git.before.status = `${legacyManifest.git.before.status}\n? .DS_Store`;
  legacyManifest.git.after.status = `${legacyManifest.git.after.status}\n? .DS_Store`;
  delete legacyManifest.source.kind;
  delete legacyManifest.git.applicable;
  legacyManifest.manifestDigest = digestObject(legacyManifest, 'manifestDigest');
  await writeJsonAtomic(legacyManifestPath, legacyManifest);
  await appendFile(legacyPayloadPath, 'finder changed it after capture\n');

  const legacyValidation = await validateCapsule(legacyCapsule);
  assert.equal(legacyValidation.valid, true);
  assert.ok(legacyValidation.warnings.some((warning) => (
    warning.code === 'ignored-manifest-platform-metadata' &&
    warning.path === '.DS_Store' &&
    warning.state === 'modified'
  )));
  const legacyDestination = path.join(root, 'legacy-restored-project');
  const legacyPlan = await createRestorePlan({ capsule: legacyCapsule, destination: legacyDestination });
  assert.equal(legacyPlan.executable, true, JSON.stringify(legacyPlan.blockers));
  assert.equal(legacyPlan.sourceKind, 'git-repository');
  assert.equal(legacyPlan.operations.some((operation) => operation.logicalPath === '.DS_Store'), false);
  const legacyPlanPath = path.join(legacyCapsule, 'operations', 'legacy-restore-plan.json');
  await writeJsonAtomic(legacyPlanPath, legacyPlan);
  const legacyReceipt = await restoreFromPlan({ plan: legacyPlanPath, approve: true });
  assert.equal(legacyReceipt.result, 'restored-and-verified');
  await assert.rejects(lstat(path.join(legacyDestination, '.DS_Store')));

  const corruptedCapsule = path.join(root, 'corrupted-capsule');
  await cp(captured.capsulePath, corruptedCapsule, { recursive: true, verbatimSymlinks: true });
  const readmeEntry = manifest.entries.find((entry) => entry.logicalPath === 'README.md');
  await appendFile(path.join(corruptedCapsule, readmeEntry.payloadPath), 'corruption\n');
  await writeFile(path.join(corruptedCapsule, 'payload', 'claude-home', 'unexpected.txt'), 'undeclared\n');
  const corruptedValidation = await validateCapsule(corruptedCapsule);
  assert.equal(corruptedValidation.valid, false);
  assert.ok(corruptedValidation.errors.some((error) => error.code === 'payload-hash-mismatch'));
  assert.ok(corruptedValidation.errors.some((error) => (
    error.code === 'unreferenced-payload' && error.path === 'unexpected.txt'
  )));

  const destination = path.join(root, 'restored-project');
  const planPath = path.join(captured.capsulePath, 'operations', 'restore-plan.json');
  const plan = await createRestorePlan({ capsule: captured.capsulePath, destination });
  assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
  assert.equal(plan.capsulePath, '$CAPSULE_ROOT');
  assert.equal(plan.validation.capsulePath, '$CAPSULE_ROOT');
  await writeJsonAtomic(planPath, plan);

  const cliPlanResult = await execFileAsync(process.execPath, [
    path.join(import.meta.dirname, '..', 'scripts', 'claude-replicant.mjs'),
    'plan',
    '--capsule',
    captured.capsulePath,
    '--destination',
    path.join(root, 'cli-restored-project'),
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  const cliPlan = JSON.parse(cliPlanResult.stdout);
  assert.equal(
    await realpath(path.dirname(cliPlan.output)),
    await realpath(path.join(captured.capsulePath, 'operations')),
  );
  assert.equal((await lstat(cliPlan.output)).isFile(), true);

  const movedCapsule = path.join(root, 'transferred-capsule');
  await cp(captured.capsulePath, movedCapsule, { recursive: true, verbatimSymlinks: true });
  const movedPlanPath = path.join(movedCapsule, 'operations', 'restore-plan.json');

  const outsidePlanPath = path.join(root, 'outside-restore-plan.json');
  await writeJsonAtomic(outsidePlanPath, plan);
  await assert.rejects(
    restoreFromPlan({ plan: outsidePlanPath, approve: true }),
    /inside its capsule operations folder/,
  );

  await assert.rejects(
    restoreFromPlan({ plan: movedPlanPath, approve: false }),
    /explicit --approve/,
  );
  await assert.rejects(
    restoreFromPlan({ plan: movedPlanPath, approve: true, receipt: path.join(root, 'outside-receipt.json') }),
    /inside the capsule operations folder/,
  );
  const receiptPath = path.join(movedCapsule, 'operations', 'restore-receipt.json');
  const receipt = await restoreFromPlan({ plan: movedPlanPath, approve: true, receipt: receiptPath });
  assert.equal(receipt.result, 'restored-and-verified');
  assert.equal(receipt.sourceKind, 'git-repository');
  assert.equal(receipt.gitVerification.applicable, true);
  assert.equal(receipt.gitVerification.status, 'verified');
  assert.equal(receipt.treeVerification.valid, true);
  assert.equal(receipt.gitVerification.valid, true);
  assert.equal(receipt.agentStateVerification.valid, true);
  assert.equal(receipt.capturedAgentStateVerification.valid, true);
  assert.equal(receipt.nativeResumeReadiness.valid, true);
  assert.deepEqual(
    new Set(receipt.nativeResumeReadiness.sessions.map((sessionEntry) => sessionEntry.sessionId)),
    new Set([sessionId, secondSessionId]),
  );
  assert.match(await readFile(receipt.reports.markdown, 'utf8'), new RegExp(sessionId));
  assert.match(await readFile(receipt.reports.markdown, 'utf8'), new RegExp(secondSessionId));
  assert.match(await readFile(receipt.reports.html, 'utf8'), new RegExp(sessionId));
  assert.match(await readFile(receipt.reports.html, 'utf8'), new RegExp(secondSessionId));
  await assert.rejects(lstat(executionMarker));

  assert.equal(await readFile(path.join(destination, 'untracked-notes.txt'), 'utf8'), 'untracked\n');
  assert.equal(await readFile(path.join(destination, 'generated', 'output.txt'), 'utf8'), 'ignored generated\n');
  await assert.rejects(lstat(path.join(destination, '.env')));
  assert.equal(await readlink(path.join(destination, 'relative-link')), 'src/work.txt');
  assert.equal(await readlink(path.join(destination, 'absolute-link')), '/tmp/claude-replicant-outside');
  assert.equal(await readFile(path.join(destination, 'unicodé-測試.txt'), 'utf8'), 'unicode\n');
  assert.equal(
    (await lstat(path.join(destination, 'hardlink-a.txt'))).ino,
    (await lstat(path.join(destination, 'hardlink-b.txt'))).ino,
  );
  assert.equal((await readJson(receiptPath)).manifestDigest, manifest.manifestDigest);
  const restoredProjectKey = receipt.destination.replaceAll(path.sep, '-');
  const restoredTranscript = await readFile(
    path.join(receipt.claudeDestination, 'projects', restoredProjectKey, `${sessionId}.jsonl`),
    'utf8',
  );
  assert.match(restoredTranscript, /Capture everything/);
  assert.match(restoredTranscript, new RegExp(receipt.destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(restoredTranscript, new RegExp(repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(
    await readFile(path.join(receipt.claudeDestination, 'agents', 'reviewer.md'), 'utf8'),
    'Review agent.\n',
  );
  assert.match(await readFile(path.join(receipt.claudeDestination, '.claude.json'), 'utf8'), /mcpServers/);

  await assert.rejects(
    restoreFromPlan({
      plan: movedPlanPath,
      approve: true,
      receipt: path.join(movedCapsule, 'operations', 'second.json'),
    }),
    /Destination must not exist/,
  );
});

test('a custom Claude config directory keeps its own .claude.json', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-replicant-custom-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const claudeHome = path.join(root, 'custom-config');
  const projectKey = repository.replaceAll(path.sep, '-');
  await mkdir(repository, { recursive: true });
  await mkdir(path.join(claudeHome, 'projects', projectKey), { recursive: true });
  await writeFile(path.join(claudeHome, '.claude.json'), '{"custom":true}\n');
  await writeFile(path.join(root, '.claude.json'), '{"unrelated":true}\n');
  await writeFile(
    path.join(claudeHome, 'projects', projectKey, '11111111-2222-4333-8444-555555555555.jsonl'),
    `${JSON.stringify({
      type: 'user',
      cwd: repository,
      sessionId: '11111111-2222-4333-8444-555555555555',
      message: { role: 'user', content: 'custom config fixture' },
    })}\n`,
  );

  const preview = await previewClaudeState({ source: repository, claudeHome });
  assert.deepEqual(preview.adjacentCandidates, []);
  assert.deepEqual(
    preview.candidates.filter((candidate) => candidate.logicalPath === '.claude.json').map((candidate) => candidate.absolutePath),
    [path.join(await realpath(claudeHome), '.claude.json')],
  );
});
