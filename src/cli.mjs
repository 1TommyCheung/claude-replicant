#!/usr/bin/env node

import path from 'node:path';
import { writeJsonAtomic } from './util.mjs';
import {
  captureRepository,
  createRestorePlan,
  restoreFromPlan,
  validateCapsule,
} from './core.mjs';

const HELP = `Claude Replicant Part 1

Usage:
  node src/cli.mjs capture --source <repo> --store <folder> [--confirm]
  node src/cli.mjs validate --capsule <capsule>
  node src/cli.mjs plan --capsule <capsule> --destination <new-path> [--output <plan.json>]
  node src/cli.mjs restore --plan <plan.json> --approve [--receipt <receipt.json>]

Safety:
  capture previews by default and writes only with --confirm.
  restore requires --approve and refuses an existing destination.
  source, store, capsule, destination, plan, and receipt paths are always explicit.
`;

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function numberOption(value, label) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'capture') {
    result = await captureRepository({
      source: options.source,
      store: options.store,
      gitPath: options.git ?? 'git',
      confirm: options.confirm === true,
      maxEntries: numberOption(options.maxEntries, '--max-entries'),
      maxBytes: numberOption(options.maxBytes, '--max-bytes'),
    });
  } else if (command === 'validate') {
    if (!options.capsule) throw new Error('validate requires --capsule.');
    result = await validateCapsule(options.capsule);
    if (!result.valid) process.exitCode = 2;
  } else if (command === 'plan') {
    result = await createRestorePlan({
      capsule: options.capsule,
      destination: options.destination,
    });
    if (options.output) {
      const output = path.resolve(options.output);
      await writeJsonAtomic(output, result);
      result = { ...result, output };
    }
    if (!result.executable) process.exitCode = 3;
  } else if (command === 'restore') {
    if (!options.plan) throw new Error('restore requires --plan.');
    result = await restoreFromPlan({
      plan: options.plan,
      approve: options.approve === true,
      receipt: options.receipt,
    });
  } else {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Claude Replicant: ${error.message}\n`);
  process.exitCode = 1;
});
