import { appendFile, access, writeFile } from 'node:fs/promises';

const [target, startSignal, readySignal] = process.argv.slice(2);
if (!target || !startSignal || !readySignal) throw new Error('helper-live-writer requires target/start/ready paths');

while (true) {
  try {
    await access(startSignal);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (let index = 0; index < 80; index += 1) {
  await appendFile(target, `${JSON.stringify({ event: 'controlled-append', index })}\n`);
  if (index === 0) await writeFile(readySignal, 'ready\n');
  await new Promise((resolve) => setTimeout(resolve, 3));
}
