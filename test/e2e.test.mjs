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
import { readJson, writeJsonAtomic } from '../src/util.mjs';

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
  await link(path.join(repository, 'hardlink-a.txt'), path.join(repository, 'hardlink-b.txt'));
  await symlink('src/work.txt', path.join(repository, 'relative-link'));
  await symlink('/tmp/claude-replicant-outside', path.join(repository, 'absolute-link'));
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture baseline']);

  await writeFile(path.join(repository, 'src', 'work.txt'), 'staged\n');
  await git(repository, ['add', 'src/work.txt']);
  await appendFile(path.join(repository, 'src', 'work.txt'), 'unstaged\n');
  await writeFile(path.join(repository, 'untracked-notes.txt'), 'untracked\n');
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

  const claudeHome = path.join(root, 'claude-home');
  const projectKey = path.resolve(repository).replaceAll(path.sep, '-');
  const claudeProject = path.join(claudeHome, 'projects', projectKey);
  const sessionId = '11111111-2222-4333-8444-555555555555';
  await mkdir(path.join(claudeProject, sessionId, 'subagents'), { recursive: true });
  await mkdir(path.join(claudeProject, 'memory'), { recursive: true });
  await mkdir(path.join(claudeHome, 'agents'), { recursive: true });
  await mkdir(path.join(claudeHome, 'skills', 'fixture-skill'), { recursive: true });
  await mkdir(path.join(claudeHome, 'plans'), { recursive: true });
  await writeFile(path.join(claudeHome, 'CLAUDE.md'), 'Global Claude instructions.\n');
  await writeFile(path.join(claudeHome, 'settings.json'), '{"theme":"dark"}\n');
  await writeFile(path.join(claudeHome, '.credentials.json'), '{"token":"must-not-copy"}\n');
  await writeFile(path.join(root, '.claude.json'), '{"projects":{"fixture":{"mcpServers":{}}}}\n');
  await writeFile(path.join(claudeHome, 'agents', 'reviewer.md'), 'Review agent.\n');
  await writeFile(path.join(claudeHome, 'skills', 'fixture-skill', 'SKILL.md'), 'Fixture skill.\n');
  await writeFile(path.join(claudeHome, 'plans', 'fixture-plan.md'), 'Project plan.\n');
  await writeFile(path.join(claudeProject, 'memory', 'MEMORY.md'), 'Remember the migration goal.\n');
  const claudeSession = path.join(claudeProject, `${sessionId}.jsonl`);
  await writeFile(
    claudeSession,
    `${JSON.stringify({ type: 'user', cwd: repository, sessionId, message: 'capture everything' })}\n`.repeat(30_000),
  );
  await writeFile(
    path.join(claudeProject, sessionId, 'subagents', 'agent-review.jsonl'),
    `${JSON.stringify({ type: 'assistant', sessionId, result: 'reviewed' })}\n`,
  );
  return { repository, session, claudeSession, claudeHome, sessionId, executionMarker };
}

test('Part 1 captures, validates, rejects corruption, plans, restores, and verifies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-replicant-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repository, claudeSession, claudeHome, sessionId, executionMarker } = await createFixture(root);
  const store = path.join(root, 'capsule-store');

  const preview = await captureRepository({ source: repository, store, claudeHome, confirm: false });
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.claudeState.sessionCount, 1);
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
  assert.equal(captured.validation.valid, true);
  assert.equal(captured.capsulePath, path.join(store, 'capsule', captured.packageId));
  await assert.rejects(lstat(path.join(store, 'capsules')));
  const catalogEntries = (await readFile(path.join(store, 'catalog.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(catalogEntries.at(-1).relativePath, `capsule/${captured.packageId}`);
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
  assert.ok(manifest.findings.some((finding) => finding.code === 'credential-excluded'));
  assert.ok(manifest.findings.some((finding) => finding.code === 'live-append-stable-prefix'));
  assert.equal(manifest.readiness.domains.repositoryData.status, 'ready');
  assert.equal(manifest.readiness.domains.gitState.status, 'ready');
  assert.equal(manifest.readiness.domains.agentState.status, 'ready');
  assert.equal(manifest.policy.agentState, 'captured-with-execution-as-authorization');
  assert.ok(manifest.agentState.entries.some((entry) => entry.logicalPath.endsWith(`${sessionId}.jsonl`)));
  assert.ok(manifest.agentState.entries.some((entry) => entry.logicalPath.endsWith('memory/MEMORY.md')));
  assert.ok(manifest.agentState.entries.some((entry) => entry.logicalPath === 'agents/reviewer.md'));
  assert.equal(await lstat(path.join(captured.capsulePath, 'capture-report.html')).then(() => true), true);
  await assert.rejects(lstat(path.join(captured.capsulePath, 'payload', 'claude-home', '.credentials.json')));

  const inventoryText = await readFile(path.join(captured.capsulePath, 'inventory.jsonl'), 'utf8');
  assert.match(inventoryText, /credential-filename-policy/);
  assert.doesNotMatch(inventoryText, /fake_fixture_secret_123456789/);

  const corruptedCapsule = path.join(root, 'corrupted-capsule');
  await cp(captured.capsulePath, corruptedCapsule, { recursive: true, verbatimSymlinks: true });
  const readmeEntry = manifest.entries.find((entry) => entry.logicalPath === 'README.md');
  await appendFile(path.join(corruptedCapsule, readmeEntry.payloadPath), 'corruption\n');
  const corruptedValidation = await validateCapsule(corruptedCapsule);
  assert.equal(corruptedValidation.valid, false);
  assert.ok(corruptedValidation.errors.some((error) => error.code === 'payload-hash-mismatch'));

  const destination = path.join(root, 'restored-project');
  const planPath = path.join(root, 'restore-plan.json');
  const plan = await createRestorePlan({ capsule: captured.capsulePath, destination });
  assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
  await writeJsonAtomic(planPath, plan);

  await assert.rejects(
    restoreFromPlan({ plan: planPath, approve: false }),
    /explicit --approve/,
  );
  const receiptPath = path.join(root, 'restore-receipt.json');
  const receipt = await restoreFromPlan({ plan: planPath, approve: true, receipt: receiptPath });
  assert.equal(receipt.result, 'restored-and-verified');
  assert.equal(receipt.treeVerification.valid, true);
  assert.equal(receipt.gitVerification.valid, true);
  assert.equal(receipt.agentStateVerification.valid, true);
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
  const restoredProjectKey = path.resolve(destination).replaceAll(path.sep, '-');
  assert.match(
    await readFile(path.join(receipt.claudeDestination, 'projects', restoredProjectKey, `${sessionId}.jsonl`), 'utf8'),
    /capture everything/,
  );
  assert.equal(
    await readFile(path.join(receipt.claudeDestination, 'agents', 'reviewer.md'), 'utf8'),
    'Review agent.\n',
  );
  assert.match(await readFile(path.join(receipt.claudeDestination, '.claude.json'), 'utf8'), /mcpServers/);

  await assert.rejects(
    restoreFromPlan({ plan: planPath, approve: true, receipt: path.join(root, 'second.json') }),
    /Destination must not exist/,
  );
});
