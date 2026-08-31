# Development Log

This log records how Claude Replicant evolved, why major design choices were made, and what evidence supports the current implementation. The changelog is the concise user-facing release record; this document is the engineering narrative.

## 2026-09-01 — v0.4.2 `.claude.json` collision fix

### Failure

A real capture of `webtrail` passed preview but failed staged validation with `duplicate-logical-path` and `payload-hash-mismatch` for `.claude.json`. The source repository was unchanged and no capsule was finalized.

### Root cause

The standard Claude layout contained both `~/.claude.json` and a shadow `~/.claude/.claude.json`. Generic root-file discovery selected the latter, while the adjacent-config collector selected the former. Both were assigned `.claude.json` as their logical and payload path. The second copy replaced the staged bytes, while the manifest retained both entries and their different hashes.

### Fix

- Recognize a `.claude` directory as the standard home layout.
- When its documented adjacent `.claude.json` exists, remove the colliding root candidate before capture.
- For a custom `CLAUDE_CONFIG_DIR`, do not infer or capture an unrelated parent-level `.claude.json`; retain the config directory's own root file.
- Preserve validation's duplicate-path and hash checks unchanged so future collisions still fail safely.

### Regression coverage

The synthetic fixture now creates two `.claude.json` files with different bytes. Capture must finalize successfully, the manifest must contain exactly one `.claude.json` agent entry, and its payload must match the authoritative adjacent file.

## 2026-09-01 — v0.4.1 documentation baseline

### Goal

Make project status, release history, implementation evidence, and specification ownership explicit before beginning Part 2.

### Work completed

- Added `docs/CHANGELOG.md` with the release history from v0.1.0 through v0.4.1.
- Added this development log.
- Added a documentation index and current version to the README.
- Updated the technical specification to distinguish completed Part 1 work, ongoing portability hardening, and planned Part 2 analysis/gold-standard work.
- Corrected the runtime description: Node.js 22 is the implemented reference path; Bun remains a future parity target.
- Added a rule requiring behavioral contract changes and specification changes to ship together.

## 2026-09-01 — v0.4.0 native Claude Code session resume

### Problem

Capturing transcript files was insufficient. A capsule restored on another computer must place each transcript where Claude Code expects it for the new working directory, update path-bound session records, and show users which sessions are available.

### Design decisions

- Treat every top-level JSONL transcript in the selected Claude project directory as a session candidate.
- Build the session catalog from the stable bytes already copied into capsule staging, not from a second read of the live Claude home.
- Preserve canonical transcript bytes in `payload/claude-home`.
- Rewrite only the restored copy of path-bound Claude state, recording source and restored SHA-256 hashes for every changed file.
- Require structural native-resume verification for every reported session before declaring restore successful.
- Put session information in all capture report formats and all restore report formats so a capsule remains inspectable without special tooling.
- Distinguish picker behavior from direct resume: interactive sessions are expected in `claude --resume`; print-mode or Agent SDK sessions may require `claude --resume <session-id>`.

### Implementation

- Added session JSONL inspection for IDs, titles/prompts, timestamps, message counts, models, branches, Claude versions, entrypoints, working directories, subagent transcripts, and tool results.
- Added `sessions.json` and `schemas/sessions.schema.json`.
- Added destination project-key and path-bound state remapping.
- Added per-session destination checks for transcript path, parseable records, matching session IDs, and destination `cwd`.
- Added restore reports in JSON, Markdown, and HTML under the capsule's `operations/` folder.
- Expanded global Claude state capture to backups, debug data, image cache, paste cache, and shell snapshots.

### Verification

- The synthetic fixture creates two distinct Claude sessions, including a CLI-style and Agent SDK-style entrypoint.
- Both sessions must appear in `sessions.json` and all capture/restore report formats.
- Both sessions must pass native-resume layout checks after restoration to a different absolute path.
- The test also verifies canonical integrity, path-remapped restored content, Git state, corruption refusal, excluded credential files, live append handling, symlinks, hardlinks, ignored content, and Unicode filenames.
- Before the v0.4.0 release, three consecutive end-to-end runs, the smoke test, the test suite from the installed plugin cache, plugin/skill validators, syntax checks, JSON parsing, and a secret-pattern scan all passed.

### Boundary

The fixture proves the documented local filesystem contract without using a real private session or making a provider-backed model call. Claude Code must be installed on the destination, and account authentication may still be required. Dedicated credential stores are not included.

## 2026-09-01 — v0.3.0 self-contained capsules

### Problem

Store-level plans, receipts, catalogs, or derivatives meant a capsule could not be moved independently without losing operational history.

### Decision and result

- Made `<store>/capsule/<capsule-id>/` the only persistent unit.
- Stored restore plans and receipts in the capsule's `operations/` directory.
- Replaced absolute capsule references in plans with `$CAPSULE_ROOT`.
- Removed store-level metadata and sidecar directories.
- Verified that a capsule can be moved to another folder before validation and restore.

## 2026-09-01 — v0.2.0 Claude state capture and restore

### Goal

Move beyond repository-only backup and capture the locally available Claude Code environment needed for continuity.

### Result

- Added selected-project sessions, memory, subagent/tool records, file history, plans, tasks, todos, agents, skills, commands, plugins, hooks, settings, and adjacent `.claude.json` state.
- Restored state into a new isolated Claude home instead of merging into an existing one.
- Returned the required `CLAUDE_CONFIG_DIR` activation value.
- Added project-key remapping and post-restore agent-state verification.

## 2026-09-01 — v0.1.1 and v0.1.2 product shape

- Standardized output under a `capsule/` subfolder.
- Documented the plugin overview, installation in Codex and Claude Code, the Part 1 migration goal, and the later analysis/gold-standard roadmap.

## 2026-08-31 — v0.1.0 initial public release

- Established the public GitHub repository and dual Codex/Claude Code plugin manifests.
- Added the portable Node.js CLI, repository/Git capture, manifest and inventory generation, SHA-256 validation, corruption refusal, filesystem probes, restore planning, and a synthetic end-to-end test.

## Ongoing engineering rules

- The capsule is the portable unit; no required state may live outside it.
- Canonical captured bytes are immutable after finalization.
- Derived analysis and future gold-standard outputs live inside their owning capsule and never replace canonical evidence.
- Capture, analysis, and restore are distinct explicit operations.
- Confirmed capture authorizes the declared repository and Claude-state roots; no per-artifact privacy prompts are added.
- Capsules are secret-bearing and must not be mistaken for sanitized share packages.
- Repository-controlled code, hooks, and lifecycle scripts are not executed during capture, validation, planning, or restore.
- A restore claim must be backed by machine-readable verification, not only by file presence or a human summary.
