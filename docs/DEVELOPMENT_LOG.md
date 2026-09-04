# Development Log

This log records how Claude Replicant evolved, why major design choices were made, and what evidence supports the current implementation. The changelog is the concise user-facing release record; this document is the engineering narrative.

## 2026-09-04 — v0.5.1 source-authoritative session discovery

### Failure

A capture of `/Users/eugeneleow/Downloads/Dinogame.gg` selected the Claude project key for `/Users/eugeneleow/Downloads/Claude Files`. One transcript in that parent workspace mentioned the Dinogame path while running a migration command, so the fallback treated the mention as ownership evidence and captured all three unrelated parent-workspace sessions. None had a recorded `cwd` equal to the selected source, leaving all three non-resumable by ID for Dinogame.

### Root cause and fix

The fallback scanner accepted either a structured `cwd` match or the source path appearing anywhere in the first transcript megabyte. Source paths in prompts and tool inputs are not reliable project identity. The adapter now parses transcript records and accepts fallback discovery only when a record's structured `cwd` equals the explicit source path or its equivalent macOS `/private` form. The exact encoded source project key remains the preferred path. If neither form exists, capture stops rather than substituting the invoking agent's workspace.

### Verification

Added a regression fixture whose parent-workspace transcript mentions the selected child source in its user message; discovery must reject it. Added a positive legacy-key fixture whose structured `cwd` equals the source; discovery must retain support for that valid relocation case. The complete existing test suite passes unchanged after updating the adapter-version assertion to `1.1.2`.

## 2026-09-04 — v0.5.0 optional Git and folder mode

### Goal

Make Git optional for projects that are ordinary folders while retaining full Git fidelity whenever a source is already a repository.

### Design

- Detect source type from the presence of `<source>/.git`.
- Use `git-repository` mode when `.git` exists. Preserve the existing safe Git probe, layout checks, snapshots, reconstruction, and post-restore verification; missing or incompatible Git remains a blocker.
- Use `folder` mode when `.git` does not exist. Do not probe or invoke Git during preview, capture, planning, or restore.
- Record `source.kind`, `git.applicable`, null Git snapshots/prerequisites, `git.reconstruction: not-applicable`, and `readiness.domains.gitState.status: not-applicable` so absence of Git is explicit rather than presented as a failure.
- Treat capsules without `source.kind` as Git-backed to preserve compatibility with releases through v0.4.4.
- Compare the folder's sorted logical-path set before and after collection and abort if membership changes; per-file fingerprint checks continue to detect content mutation during reads.

### Verification

The folder-mode fixture uses a source with no `.git`, a matching synthetic Claude Code session, a known credential file that must remain excluded, and an intentionally unusable Git path. It removes executable discovery from `PATH` during planning and restore, then requires a verified restored project, `gitVerification.status: not-applicable`, destination path remapping, and native session resume readiness. The existing Git-backed fixture still passes its full branch/refs/index/status and hostile-hook protections.

## 2026-09-01 — v0.4.4 Finder metadata validation fix

### Failure

A captured capsule failed validation after four `.DS_Store` files appeared under `payload/claude-home`. The files were not in the manifest, so the validator correctly identified them as unreferenced payload, but treated disposable Finder metadata as equivalent to undeclared restorable content.

### Root cause

macOS Finder can create `.DS_Store` files when browsing a directory after capture finalization or transfer. The manifest is authoritative and restore reads only manifest entries, so these regular files cannot affect restored state. The validator nevertheless enforced byte-for-byte directory closure without a platform-metadata exception. Capture also copied untracked `.DS_Store` files and included them in Git status expectations.

### Fix and safety boundary

- Exclude untracked regular `.DS_Store` files during future repository and Claude-state captures and record the exclusion as `platform-metadata-policy` in the inventory.
- Remove those policy-excluded paths from the expected restored Git status.
- During validation, downgrade only an unreferenced regular file whose exact basename is `.DS_Store` to `ignored-unreferenced-platform-metadata`.
- For legacy manifests, identify repository `.DS_Store` entries absent from the captured Git index (and Claude-home `.DS_Store` entries) as non-restorable platform metadata. Report them as `ignored-manifest-platform-metadata`, omit them from restore operations, and remove their untracked/ignored lines from expected Git status.
- Do not delete the file, rewrite the capsule, or edit its manifest.
- Continue rejecting every other unreferenced file, every unreferenced directory or symlink (including one named `.DS_Store`), and any hash change to a manifest-referenced `.DS_Store`.

### Regression coverage

The end-to-end fixture covers all four reported paths, verifies capture-time exclusion, recreates the files after finalization, simulates a legacy manifest whose untracked `.DS_Store` changed after capture, proves that an unrelated undeclared file still blocks restore, proves tracked metadata remains canonical, and completes transferred restore and Git-state verification without restoring disposable metadata.

## 2026-09-01 — v0.4.3 operational examples

- Added agent-ready installation prompts for Codex and Claude Code.
- Added end-to-end README examples for previewed backup, explicit capture approval, validation after transfer, dry-run restore planning, explicit restore approval, isolated restoration, and native session resume.
- Kept shell commands beside the natural-language prompts so users can audit or run the same operations manually.
- Linked the Codex instructions to the official OpenAI plugin marketplace workflow and the Claude instructions to Claude Code's marketplace, user-scope installation, and reload behavior.

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
