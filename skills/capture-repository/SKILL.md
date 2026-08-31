---
name: capture-repository
description: Capture, validate, plan, or restore a selected Git repository together with its Claude Code sessions, memory, subagents, plans, skills, commands, plugins, and agent configuration. Use for complete local Claude project migration capsules, not ordinary Git commits or credential transfer.
---

# Capture Repository

Use the deterministic CLI at `scripts/claude-replicant.mjs` in this plugin root. Resolve its absolute path from this skill's installed location; do not assume the user's current directory contains the plugin.

## Boundaries

- Require an explicit source repository and capsule-store folder. Resolve Claude state from `--claude-home`, `CLAUDE_CONFIG_DIR`, or `~/.claude`, in that order.
- Part 1 captures the repository plus locally available Claude Code project sessions, memory, subagent records, file history, plans, tasks, skills, commands, plugins, hooks, settings, adjacent `.claude.json` project/MCP state, and related agent state. Restore remaps the Claude project key and path-bound transcript/configuration fields to the destination repository so Claude Code can natively resume the migrated sessions. It does not claim to capture provider-side hidden state, external accounts, dependencies, or model internals.
- Running confirmed capture is the user's authorization to read and preserve the declared repository and Claude state scope. Do not add separate privacy-consent prompts for individual artifacts.
- Treat capsules as secret-bearing. Raw session content is preserved without content redaction and can contain credentials or private information. Dedicated credential stores remain excluded; never print their values.
- Use the provided CLI rather than repository scripts or hooks. Do not execute code/configuration from the selected repository.
- Do not add remotes, upload data, install dependencies, or overwrite an existing restore destination.

## Capture

1. Ensure the user has identified the source repository and destination store as separate, non-overlapping paths.
2. Run `node <plugin-root>/scripts/claude-replicant.mjs capture --source <source> --store <store>` without `--confirm`. Add `--claude-home <path>` only when the user uses a nonstandard Claude configuration directory. This is a read-only preview.
3. Present the resolved paths, repository and Claude-state candidate/session counts, Git/layout findings, exclusions policy, and secret-bearing warning.
4. Only after explicit approval, repeat the command with `--confirm`.
5. Report the self-contained capsule path as `<store>/capsule/<capsule-id>/`, its `sessions.json`, JSON/Markdown/HTML capture reports, manifest digest, validation result, domain readiness, and limitations. Confirm that every captured session ID appears in all three human/machine report forms. Capture must not create `store.json`, catalogs, derivative folders, receipt folders, or any other files alongside the capsule. Non-ready repository, Git, or agent-state domains do not qualify as a complete restorable capture.

## Validate and plan

- Validate read-only with `validate --capsule <capsule>`. Stop on any hash, manifest, path, or report error.
- Create a plan with `plan --capsule <capsule> --destination <nonexistent-path> --claude-destination <nonexistent-claude-home>`. The CLI writes it under `<capsule>/operations/`; an `--output` override is allowed only when it names a direct child of that same folder. If omitted, the isolated Claude home defaults to `<destination>.claude-home`.
- Keep the plan outside the destination. Show blockers and declared variances; do not describe a non-executable plan as restorable.

## Restore

1. Confirm the capsule validates, the plan is executable, both destinations are exact and nonexistent, and the user has reviewed variances.
2. Ask for explicit approval immediately before the write.
3. Run `restore --plan <capsule>/operations/<plan.json> --approve`. The receipt is written to the same capsule `operations/` folder. A `--receipt` override is allowed only within that folder.
4. Require `nativeResumeReadiness.valid` and every per-session result to be true before describing restore as complete. Report repository, Git, Claude-state, and native-resume verification; JSON/Markdown/HTML restore-report paths; the session picker command; every direct session resume command; and the returned `CLAUDE_CONFIG_DIR=<restored-home>` value. Note that destination reauthentication can still be required. If restore fails, do not improvise an overwrite or destructive cleanup.
