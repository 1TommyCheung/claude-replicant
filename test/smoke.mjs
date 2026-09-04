import { spawn } from 'node:child_process';

const child = spawn(process.execPath, [
  '--test',
  'test/e2e.test.mjs',
  'test/folder-mode.test.mjs',
], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});

child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
