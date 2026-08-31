---
name: capture-repository
description: Capture, validate, plan, or restore a selected Git repository with Claude Replicant when the user wants a local migration capsule or repository recovery. Do not use for ordinary Git commits, remote backups, agent-state migration, or credential transfer.
---

# Capture Repository

Use the deterministic CLI at `scripts/claude-replicant.mjs` in this plugin root. Resolve its absolute path from this skill's installed location; do not assume the user's current directory contains the plugin.

## Boundaries

- Require an explicit source repository and capsule-store folder. Never infer a home-wide or user-global scope.
- Part 1 captures repository data only. Do not claim Claude/Codex session state, credentials, dependencies, external accounts, or semantic analysis are captured.
- Treat capsules as secret-bearing even though known credential files are excluded. Never print excluded values.
- Use the provided CLI rather than repository scripts or hooks. Do not execute code/configuration from the selected repository.
- Do not add remotes, upload data, install dependencies, or overwrite an existing restore destination.

## Capture

1. Ensure the user has identified the source repository and destination store as separate, non-overlapping paths.
2. Run `node <plugin-root>/scripts/claude-replicant.mjs capture --source <source> --store <store>` without `--confirm`. This is a read-only preview.
3. Present the resolved paths, candidate count, Git/layout findings, exclusions policy, and secret-bearing warning.
4. Only after explicit approval, repeat the command with `--confirm`.
5. Report the self-contained capsule path as `<store>/capsule/<capsule-id>/`, plus its manifest digest, validation result, domain readiness, and limitations. A non-ready Git domain is not a successful restorable Part 1 capture.

## Validate and plan

- Validate read-only with `validate --capsule <capsule>`. Stop on any hash, manifest, path, or report error.
- Create a plan with `plan --capsule <capsule> --destination <nonexistent-path> --output <plan.json>`.
- Keep the plan outside the destination. Show blockers and declared variances; do not describe a non-executable plan as restorable.

## Restore

1. Confirm the capsule validates, the plan is executable, the destination is exact and nonexistent, and the user has reviewed variances.
2. Ask for explicit approval immediately before the write.
3. Run `restore --plan <plan.json> --approve --receipt <receipt.json>` with the receipt outside the destination.
4. Report post-restore tree/Git verification and the receipt path. If restore fails, do not improvise an overwrite or destructive cleanup.
