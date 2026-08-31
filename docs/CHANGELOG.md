# Changelog

All notable user-visible changes to Claude Replicant are recorded here. Versions follow semantic versioning for the plugin and CLI. Capsule schema versions are tracked independently inside generated artifacts and schema files.

## 0.4.4 — 2026-09-01

### Fixed

- Fixed transferred capsules being rejected when macOS Finder added unreferenced `.DS_Store` files inside the payload after manifest finalization.
- Validation now reports unreferenced regular `.DS_Store` files as `ignored-unreferenced-platform-metadata` warnings; it neither restores them nor changes the manifest.
- Legacy capsules that included untracked `.DS_Store` files in their manifests now report those entries as `ignored-manifest-platform-metadata` and omit them from restore, even if Finder changed or removed them after capture.
- All other unreferenced files, directories, and symlinks remain hard `unreferenced-payload` errors.
- New captures exclude untracked `.DS_Store` files from repository and Claude-state payloads and from the expected restored Git status. Tracked `.DS_Store` files remain canonical content and retain full hash verification.

### Verified

- Added regression coverage for the four reported Finder paths, legacy referenced metadata modified after capture, capture-time exclusion, post-finalization validation, strict rejection of a non-metadata extra file, tracked metadata integrity, corruption detection, transfer, restore, and Git verification.

## 0.4.3 — 2026-09-01

### Documentation

- Added copy-paste prompts that direct Codex or Claude Code to install or update Claude Replicant from its public GitHub marketplace.
- Added complete backup, post-transfer validation, and cross-computer restore examples with agent prompts and equivalent standalone CLI commands.
- Documented the required preview/approval boundaries, capsule transfer unit, isolated Claude home, session picker, direct session resume, and destination reauthentication caveat.

## 0.4.2 — 2026-09-01

### Fixed

- Fixed capture failure when both `~/.claude.json` and `~/.claude/.claude.json` exist.
- The standard `~/.claude` layout now captures the documented adjacent `~/.claude.json` exactly once and ignores the colliding shadow path.
- Custom Claude configuration directories continue to capture their own root-level `.claude.json` without importing an unrelated file from the parent directory.
- Bumped the Claude Code filesystem adapter version to `1.1.1`.

### Verified

- Added a regression fixture with two different `.claude.json` files and asserted that the capsule contains one authoritative logical entry with the expected bytes.

## 0.4.1 — 2026-09-01

### Documentation

- Added this versioned changelog and a detailed development log.
- Updated the README with the current release and documentation index.
- Reconciled the technical specification with the implemented Node.js runtime, completed plugin distribution, native session resume, and planned Part 2 work.
- Added specification-maintenance rules so future contract changes update the specification and logs together.

## 0.4.0 — 2026-09-01

### Added

- Added `sessions.json`, containing every locally stored session found for the selected Claude Code project.
- Added the complete session list to JSON, Markdown, and static HTML capture reports.
- Added JSON, Markdown, and static HTML restore reports with picker and direct-resume commands.
- Added a JSON Schema for the session catalog.

### Changed

- Restore now remaps the Claude project key and path-bound transcript/configuration references to the destination repository.
- Canonical capsule bytes remain unchanged; restored path-remapped files receive separate audited hashes.
- Restore now fails unless every cataloged session satisfies the destination project-path, session-ID, JSONL, and `cwd` checks required by the native resume layout.
- Expanded captured Claude directories to include backups, debug data, image/paste caches, and shell snapshots.

### Verified

- Added a two-session cross-path synthetic fixture covering session reports and native-resume verification.
- Passed repeated end-to-end tests, smoke tests, plugin validation, schema parsing, syntax checks, and public-repository secret-pattern scans.

## 0.3.0 — 2026-09-01

- Made each capsule fully self-contained under `<store>/capsule/<capsule-id>/`.
- Moved restore plans and receipts into the capsule's `operations/` directory.
- Removed store-level catalogs, receipt folders, shared derivative directories, and other sidecars.
- Made restore plans portable after moving or zipping a capsule by using the capsule root as the payload reference.

## 0.2.0 — 2026-09-01

- Added capture and isolated restore of locally available Claude Code project sessions, memory, agents, skills, plans, tasks, settings, and related state.
- Added Claude project-key remapping for a different destination repository path.
- Added post-restore Claude-state verification and `CLAUDE_CONFIG_DIR` activation output.

## 0.1.2 — 2026-09-01

- Added the product overview, Codex and Claude Code installation instructions, Part 1 scope, and Part 2 roadmap.

## 0.1.1 — 2026-09-01

- Changed capture output to `<store>/capsule/<capsule-id>/`.

## 0.1.0 — 2026-08-31

- Published the initial public plugin, portable Node.js CLI, capsule schemas, integrity validation, restore planning, and synthetic end-to-end fixture.
