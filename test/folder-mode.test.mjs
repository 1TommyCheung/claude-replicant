import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureRepository,
  createRestorePlan,
  restoreFromPlan,
  validateCapsule,
} from '../src/core.mjs';
import { readJson, writeJsonAtomic } from '../src/util.mjs';

test('folder mode captures and restores Claude sessions without Git', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-replicant-folder-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'plain-project');
  const store = path.join(root, 'capsule-store');
  const claudeHome = path.join(root, 'claude-home');
  const projectKey = path.resolve(source).replaceAll(path.sep, '-');
  const projectSessions = path.join(claudeHome, 'projects', projectKey);
  const sessionId = '12345678-1234-4123-8123-123456789abc';
  await mkdir(path.join(source, 'notes'), { recursive: true });
  await mkdir(projectSessions, { recursive: true });
  await writeFile(path.join(source, 'README.md'), '# Plain folder project\n');
  await writeFile(path.join(source, 'notes', 'continuity.txt'), 'preserve this without Git\n');
  await writeFile(path.join(source, '.env'), 'API_KEY=folder_fixture_secret_123456789\n');
  await writeFile(path.join(claudeHome, 'CLAUDE.md'), 'Folder-mode global instructions.\n');
  await writeFile(
    path.join(projectSessions, `${sessionId}.jsonl`),
    `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      uuid: 'abcdefab-cdef-4abc-8def-abcdefabcdef',
      timestamp: '2026-09-04T01:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: source,
      sessionId,
      version: '2.1.250',
      message: { role: 'user', content: 'Resume this project without Git.' },
    })}\n`,
  );

  const missingGit = path.join(root, 'git-is-not-installed');
  const preview = await captureRepository({
    source,
    store,
    claudeHome,
    gitPath: missingGit,
    confirm: false,
  });
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.sourceKind, 'folder');
  assert.equal(preview.git.applicable, false);
  await assert.rejects(lstat(store));

  const changingStore = path.join(root, 'changing-folder-store');
  const appearedDuringCapture = path.join(source, 'appeared-during-capture.txt');
  await assert.rejects(
    captureRepository({
      source,
      store: changingStore,
      claudeHome,
      gitPath: missingGit,
      confirm: true,
      beforeTreeCapture: () => writeFile(appearedDuringCapture, 'late file\n'),
    }),
    /Source folder structure changed during capture/,
  );
  await rm(appearedDuringCapture);

  const captured = await captureRepository({
    source,
    store,
    claudeHome,
    gitPath: missingGit,
    confirm: true,
  });
  assert.equal(captured.sourceKind, 'folder');
  assert.equal(captured.validation.valid, true);
  const manifest = await readJson(path.join(captured.capsulePath, 'manifest.json'));
  assert.equal(manifest.source.kind, 'folder');
  assert.equal(manifest.git.applicable, false);
  assert.equal(manifest.git.prerequisite, null);
  assert.equal(manifest.git.before, null);
  assert.equal(manifest.git.after, null);
  assert.equal(manifest.git.reconstruction, 'not-applicable');
  assert.equal(manifest.readiness.domains.gitState.status, 'not-applicable');
  assert.equal(manifest.entries.some((entry) => entry.logicalPath === '.env'), false);
  assert.match(await readFile(path.join(captured.capsulePath, 'capture-report.md'), 'utf8'), /Source type: folder/);
  assert.match(await readFile(path.join(captured.capsulePath, 'capture-report.html'), 'utf8'), /Git<\/dt><dd>Not applicable/);
  assert.equal((await validateCapsule(captured.capsulePath)).valid, true);

  const destination = path.join(root, 'restored-plain-project');
  const claudeDestination = path.join(root, 'restored-claude-home');
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(root, 'no-executables');
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  const plan = await createRestorePlan({
    capsule: captured.capsulePath,
    destination,
    claudeDestination,
  });
  assert.equal(plan.executable, true, JSON.stringify(plan.blockers));
  assert.equal(plan.sourceKind, 'folder');
  assert.equal(plan.git, null);
  const planPath = path.join(captured.capsulePath, 'operations', 'folder-restore-plan.json');
  await writeJsonAtomic(planPath, plan);
  const receipt = await restoreFromPlan({ plan: planPath, approve: true });

  assert.equal(receipt.result, 'restored-and-verified');
  assert.equal(receipt.sourceKind, 'folder');
  assert.equal(receipt.gitVerification.applicable, false);
  assert.equal(receipt.gitVerification.status, 'not-applicable');
  assert.equal(receipt.nativeResumeReadiness.valid, true);
  assert.equal(await readFile(path.join(destination, 'notes', 'continuity.txt'), 'utf8'), 'preserve this without Git\n');
  await assert.rejects(lstat(path.join(destination, '.git')));
  await assert.rejects(lstat(path.join(destination, '.env')));
  assert.equal(
    (await readFile(
      path.join(
        receipt.claudeDestination,
        'projects',
        path.resolve(receipt.destination).replaceAll(path.sep, '-'),
        `${sessionId}.jsonl`,
      ),
      'utf8',
    )).includes(`"cwd":"${receipt.destination}"`),
    true,
  );
});
