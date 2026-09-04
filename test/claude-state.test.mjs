import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { previewClaudeState } from '../src/claude-state.mjs';

async function writeSession(projectDirectory, sessionId, record) {
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    path.join(projectDirectory, `${sessionId}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
}

test('session discovery rejects a parent-workspace session that only mentions the source path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-replicant-source-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'workspace', 'selected-project');
  const parentWorkspace = path.dirname(source);
  const claudeHome = path.join(root, 'claude-home');
  const parentProjectKey = parentWorkspace.replaceAll(path.sep, '-');
  await mkdir(source, { recursive: true });
  await writeSession(
    path.join(claudeHome, 'projects', parentProjectKey),
    '12345678-1234-4123-8123-123456789abc',
    {
      type: 'user',
      cwd: parentWorkspace,
      sessionId: '12345678-1234-4123-8123-123456789abc',
      message: { role: 'user', content: `Capture the source folder ${source}.` },
    },
  );

  await assert.rejects(
    previewClaudeState({ source, claudeHome }),
    /No Claude Code project session directory matches the selected project/,
  );
});

test('session discovery accepts structured cwd evidence under a legacy project key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-replicant-source-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = path.join(root, 'selected-project');
  const claudeHome = path.join(root, 'claude-home');
  const legacyProjectKey = '-legacy-project-key';
  const sessionId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  await mkdir(source, { recursive: true });
  await writeSession(
    path.join(claudeHome, 'projects', legacyProjectKey),
    sessionId,
    {
      type: 'user',
      cwd: source,
      sessionId,
      message: { role: 'user', content: 'Continue this project.' },
    },
  );

  const preview = await previewClaudeState({ source, claudeHome });
  assert.equal(preview.projectKey, legacyProjectKey);
  assert.equal(preview.discoveryMethod, 'session-cwd-evidence');
  assert.deepEqual(preview.sessionIds, [sessionId]);
});
