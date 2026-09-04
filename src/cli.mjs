#!/usr/bin/env node

import { writeJsonAtomic } from './util.mjs';
import {
  captureRepository,
  createRestorePlan,
  resolveCapsuleOperationPath,
  restoreFromPlan,
  validateCapsule,
} from './core.mjs';

const HELP = `Claude Replicant Part 1

Usage:
  node src/cli.mjs capture --source <project> --store <folder> [--claude-home <folder>] [--confirm]
  node src/cli.mjs validate --capsule <capsule>
  node src/cli.mjs plan --capsule <capsule> --destination <new-path> [--claude-destination <new-path>] [--output <capsule/operations/name.json>]
  node src/cli.mjs restore --plan <capsule/operations/plan.json> --approve [--receipt <capsule/operations/name.json>]

Safety:
  capture previews by default and writes only with --confirm.
  restore requires --approve and refuses an existing destination.
  capture includes restorable Claude Code sessions and agent state from CLAUDE_CONFIG_DIR.
  Git is auto-detected: projects without .git use folder mode and do not require Git.
  Projects with .git retain strict Git capture and require Git >=2.39.0 <3.0.0.
  restore writes an isolated Claude home (default: <destination>.claude-home).
  plans and receipts are stored only inside the capsule operations folder.
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
      claudeHome: options.claudeHome,
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
      claudeDestination: options.claudeDestination,
    });
    const output = await resolveCapsuleOperationPath({
      capsule: options.capsule,
      requested: options.output,
      filename: `${result.planId}.json`,
    });
    await writeJsonAtomic(output, result);
    result = { ...result, output };
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
