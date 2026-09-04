# Claude Replicant: Technical Design

Specification version: 0.5.1

Status: Part 1 implemented; Part 2 analysis and gold-standard cross-agent work remains planned

Target platform: macOS  
Reference runtime: Node.js 22; Bun parity remains a future portability milestone

## 1. Purpose

Claude Replicant's primary backup is a **canonical full-fidelity migration capsule** for a Claude Code project. Its non-negotiable purpose is to recreate the project on another Mac as faithfully as feasible and provide comparable context for continuing work. A project may be a Git repository or an ordinary folder. The capsule preserves project bytes and, when Git is applicable, repository state including captured uncommitted changes; locally available Claude Code project, session, memory, subagent, plan, task, skill, command, plugin, hook, and settings state; generated and temporary artifacts in the declared capture scope; relevant configuration; tool, runtime, and dependency environment information; and a verifiable inventory. Part 1 restores captured Claude filesystem state into a new isolated configuration directory, remaps the path-derived project key, and returns the `CLAUDE_CONFIG_DIR` activation value without overwriting an existing Claude home.

The system also derives smaller packages for understanding, cross-agent use, or sharing. Those derivatives may be deliberately lossy or redacted, but they never replace, rewrite, or become the canonical backup. Claude Replicant treats an agent session as evidence rather than as a single opaque transcript: repository state, agent-created memory, session records, temporary outputs, settings, logs, environment facts, and provenance are collected into inspectable packages with explicit privacy and integrity controls.

Claude Replicant itself is distributed and experienced as a plugin. The plugin exposes user-facing skills/commands and bundles or invokes a standalone shared core. The core owns discovery, policy, analysis, packaging, validation, redaction, storage, and restoration planning. Codex and Claude Code integrations translate agent-specific inputs and outputs into this stable contract. The plugin is the product boundary, but the capsule format and core runtime contract remain portable: a capsule must remain independently inspectable and restorable after transfer, without dependence on the originating conversation or plugin installation.

## 2. Goals

- Create a complete, restorable migration capsule of the declared Claude Code project scope as the primary artifact.
- Preserve original project and agent-state data faithfully before producing summaries, transformations, or cross-agent views.
- Produce deterministic, versioned, inspectable packages with provenance and content hashes.
- Support four deliberate package types: forensic backup, project context, shareable package, and restore package.
- Restore context safely without silently overwriting a working repository or agent state.
- Allow Claude Code and Codex to consume the same normalized observations and summaries.
- Prefer Bun on macOS while preserving a tested, portable Node.js execution path.
- Make every inclusion, exclusion, transformation, and redaction auditable.
- Report restore readiness and every fidelity gap, nonportable item, or required user action.
- Measure comparable-context restoration against explicit acceptance criteria rather than claiming identical agent state.
- Let the user explicitly select or create the destination capsule-store folder for every capture.
- Keep capture and analysis separate so a durable backup can finish without waiting for model-driven or repository-level analysis.
- Expose explicit plugin actions without mutating, replacing, or polluting the user's normal agent task context.
- Default to local processing and least disclosure.

### 2.1 Part 1 delivery boundary: project and local Claude state migration

Part 1 is complete only when Claude Replicant can back up and **actually restore** the selected project and locally available Claude Code state on another Mac or isolated destination macOS environment. The restored Claude home must satisfy Claude Code's native session layout so the selected project's interactive sessions are available through `claude --resume` and every captured session can be addressed by ID. It is not satisfied by a summary, inventory, dry-run plan, or agent handoff alone.

Part 1 includes:

- the complete selected working-tree scope with byte integrity, including declared untracked and ignored/generated items;
- for `git-repository` sources, the declared Git state required to reproduce the captured repository state, including object/refs/HEAD/index and staged/unstaged state to the extent proven safe and portable by Section 7.1; for `folder` sources, an explicit `not-applicable` Git domain;
- Claude Code project transcripts, subagents/tool results, memory, file history, tasks/todos, plans, and user agent configuration, plus an explicit catalog of every captured selected-project session;
- the F0 metadata envelope, source/destination capability probes, manifest/inventory hashes, secret exclusions, live-consistency findings, and restore readiness;
- transfer to a different absolute path, plugin-free Node validation, destination reassessment, a versioned dry-run restore plan, explicit approval, actual isolated project and Claude-home restore writes, project-key and path-bound transcript/config remapping, post-restore byte/agent-state verification plus Git verification when applicable, per-session native-resume verification, and JSON/Markdown/HTML restore receipts.

Part 1 includes a Claude Code filesystem adapter and treats confirmed execution as authorization for its declared repository and Claude-state scope; it does not require per-artifact privacy prompts. Part 1 excludes dedicated credential stores, provider-side state, model internals, semantic/model analysis, dependency installation, external accounts, and Codex-native task restoration.

Part 1 acceptance requires the Section 12.1 fixtures to prove source-to-destination restoration at a different path: every included regular-file hash matches before destination remapping; every path-remapped agent file has an audited source/restored digest; symlink semantics and supported metadata match; branch/HEAD/refs/index and staged/unstaged status match the declared Git expectations when Git is applicable; required untracked/ignored items exist in Git-backed mode; every reported session is present under the destination's encoded project path with its session ID and destination `cwd`; no project-controlled code executes; corruption prevents restore; and the receipt enumerates every source/destination variance. Unsupported xattrs, ACLs, flags, timestamps, filename semantics, path-bound Git state, external objects, submodules, or other portability gaps must be reported honestly and must prevent an unqualified `ready`/full-fidelity claim. A content-complete restore may still be useful with `action-required`, but it cannot silently satisfy a stricter metadata promise.

## 3. Non-goals

- Reproducing an agent's hidden model state, system prompt, or provider-side state.
- Guaranteeing byte-for-byte replay of a model interaction.
- Claiming that provider-side state, credentials, keychain entries, licenses, or external accounts can be migrated without user authorization and provider support.
- Replacing Git, backups, artifact stores, or secret managers.
- Automatically uploading packages or configuring remote storage.
- Executing captured scripts, hooks, binaries, or generated code during inspection or restore.
- Making arbitrary packages safe merely because they pass hash validation.
- Making the portable format or core contract usable only from one plugin host, skill, conversation, or agent.

## 4. Architecture

```text
Claude Replicant plugin
  |-- user-facing skills/commands
  |-- Claude Code adapter --------\
  `-- Codex adapter ---------------+-- portable shared core
                                          |-- capture + package/store I/O
                                          |-- deferred analysis + derivation
                                          |-- policy + redaction
                                          |-- integrity validation
                                          `-- restore planner/executor
```

### 4.1 Shared core

The shared core is an ECMAScript module library and CLI contract. Its public interfaces use portable JavaScript and Node-compatible APIs. It contains:

- **source discovery:** locates candidate project and agent artifacts through versioned adapters; discovered paths are never assumed to be stable;
- **capture planner:** classifies candidates, applies inclusion policy, estimates sensitivity and size, and creates an approval-ready plan;
- **repository analyzer:** records structured observations without executing repository code;
- **content pipeline:** streams bytes, normalizes metadata, redacts when required, and calculates hashes;
- **package writer/reader:** emits and reads the common package envelope and type-specific payload;
- **validator:** validates schema, manifest closure, hashes, relationships, and policy claims;
- **restore planner/executor:** maps package content to an isolated target and applies only approved operations;
- **storage abstraction:** supports local directory and archive storage initially, with remote backends deferred.

Runtime-specific acceleration belongs behind interfaces. A Bun implementation may optimize hashing, archive creation, file I/O, or metadata storage, but every required core operation must have an equivalent Node.js implementation. Bun-only features cannot leak into the package format or adapter protocol.

### 4.2 Thin integrations

Each agent integration provides only:

1. source locators and parsers for documented or observed agent artifacts;
2. a mapping into normalized core records;
3. presentation of capture/restore plans and the single explicit execution confirmation in the agent's UX;
4. generation of agent-native handoff material from normalized observations;
5. capability/version metadata about the integration itself.

An integration must not independently decide redaction, hashes, package layout, or destructive restore behavior. A CLI must be able to inspect and validate a package without either integration installed.

The portable capsule schemas, inventory, readiness records, report JSON, derivatives, and evidence/provenance vocabulary are integration-neutral. Claude Code is the primary integration, but Claude Code and Codex adapters follow the same boundary: each discovers only its own safely accessible local skills, MCP configuration/use evidence, project instructions, and session artifacts, then maps those facts into the common schema. An adapter reports `unknown` or `unavailable` when its platform cannot safely expose a fact; equivalent access to undocumented agent state is never assumed. Codex support must not consume, interpret as authority, or execute Claude-specific configuration, and Claude Code support must not do so with Codex-specific configuration.

### 4.3 Plugin responsibilities and interaction contract

The Claude Replicant plugin is responsible for discoverability and safe orchestration. It exposes independently invocable skills/commands for at least:

- **capture/backup:** choose a Claude Code project and an explicit destination folder, preview scope/policy, and create a capsule with an immutable canonical payload;
- **open capsule:** select one self-contained capsule folder on the current Mac and validate it directly;
- **list/inspect:** scan `capsule/*/manifest.json` when grouping multiple capsules, then browse reports, inventory, validation, and restore readiness without creating a catalog;
- **analyze capsule:** run a separately approved, repeatable analysis and write a derivative analysis record;
- **inspect sessions:** view recorded session history, model identifiers where the source artifacts recorded them, and derived session summaries with provenance;
- **derive:** create project-context, shareable, or restore packages from a selected canonical capsule;
- **restore:** dry-run and execute the staged migration workflow.

Exact command spelling is a plugin UX decision, but each command maps to a stable core operation and can be invoked without starting a new product-development task. Long-running work reports progress and writes to isolated staging; it must not rewrite the current project, Claude Code session, memory, settings, or prompt context merely because the plugin is installed or a store is opened. Capture is an explicit user action, uses a read-only view of the source, and returns a compact result. Analysis and restore are separate explicit actions. The plugin asks for the destination folder rather than assuming the project directory, home directory, or plugin installation directory.

The plugin may render summaries into an agent conversation on request, but capsule scanning, validation, and capture do not automatically inject capsule content into the model context. This keeps routine backup from disrupting normal agent work or changing its disclosure boundary.

## 5. Package model

### 5.1 Self-contained capsule folders

The user selects a destination root, but the only persistent capture output beneath it is `capsule/<capsule-id>/`. The root has no store metadata, catalog, shared derivatives, receipt directory, or other sidecar state. The plugin validates write access, free space, path safety, and destination filesystem capabilities before capture; it never silently falls back to another destination.

```text
chosen-store/
  capsule/
    <capsule-id>/
      manifest.json
      inventory.jsonl
      agent-environment-profile.json
      payload/
      capture-report.json
      capture-report.md
      capture-report.html
      sessions.json
      redaction-report.json
      restore-readiness.json
      validation.json
      operations/
        <restore-plan>.json
        <restore-receipt>.json
        <restore-receipt>.md
        <restore-receipt>.html
      derivatives/        # future analysis/context outputs for this capsule only
        <derivative-id>/
          manifest.json
          summary.md
          project-snapshot.html
          observations.json
          analysis.json
      signatures/        # optional, future-compatible
```

Each `<capsule-id>/` is independently movable and zip-ready and contains all project/agent payloads, reports, validation data, operational plans, receipts, and future derivatives associated with that capture. The canonical payload and manifest remain authoritative; operational records and derivatives do not alter their hashes. Finalization uses a private staging directory inside `chosen-store/capsule/` followed by an atomic rename.

One capsule folder can be copied with Finder, an external disk, or another user-authorized transfer mechanism to a different Mac. Multiple complete capsule folders may be grouped in one archive without creating shared metadata outside them. Validation and restore never depend on a catalog or `store.json`.

Before capture, the core probes and records the store filesystem type and observed behavior: case sensitivity/preservation, Unicode normalization/round-trip behavior, maximum filename/path behavior relevant to the source, symlink support, mode and timestamp precision, extended attributes, ACLs, BSD flags, atomic rename, and durable-write primitives. Probes use private temporary names inside the chosen store and clean them up. Failure to preserve a source-required capability produces an explicit readiness finding before bytes are copied. APFS is the reference fidelity target. On non-APFS stores, capture may proceed only when the capsule's metadata envelope can losslessly represent source semantics independent of the store; otherwise status is `action-required` or `not-ready`. The tool must never infer F0 fidelity merely from a successful file copy to exFAT, FAT, SMB, a cloud-synced folder, or another filesystem with weaker semantics.

All four package types share a versioned logical envelope. Derivatives live under their owning capsule's `derivatives/` directory. Canonical capture does not require `summary.md`, `observations.json`, or `analysis.json`; those are derived later.

### 5.2 Common manifest

`manifest.json` is canonical JSON with a versioned schema. At minimum it records:

- package ID, package type, schema version, creation time, and tool/core version;
- source project identity using local-safe identifiers, Git metadata when available, and an optional user label;
- source agent(s), adapter versions, source artifact kinds, and capture invocation ID;
- Agent Environment Profile schema/version, collection status, scope boundaries, evidence references, and any derivative profile IDs;
- runtime selection: executable path, runtime name, version, revision when available, compatibility profile, and probe results;
- policy profile and invocation-authorization record; requested, included, excluded, transformed, and failed items;
- entries with logical path, media type, byte length, SHA-256 digest, capture method, source timestamp, sensitivity class, and transformation lineage;
- a concrete metadata envelope per entry: entry kind; logical path plus filename code points and normalization form; regular-file content digest; symlink target captured as link text without dereferencing by default; POSIX mode; user/group identifiers as advisory source facts; size; birth/modification/access/change times with source precision; extended-attribute names, values or policy exclusions and digests; ACL text/binary representation; BSD file flags; Finder/resource-fork metadata when represented by xattrs; hard-link group; and capture errors;
- parent package IDs and hashes for derived packages;
- fidelity class, declared capture scope, source snapshot boundaries, and restore-readiness status;
- completeness status (`complete`, `partial`, or `failed`) and machine-readable warnings;
- hash algorithm, canonicalization rules, and optional signature metadata.

The manifest must not store an unredacted absolute home path by default. It uses logical source roots and stable aliases. When absolute paths are necessary for a local forensic backup, they are sensitivity-marked and excluded from derived shareable packages.

Symlinks are captured as symlinks and never followed during the default project walk. Their targets are classified as relative, absolute, in-scope, or out-of-scope; absolute/out-of-scope links create portability findings. Dereferencing requires a separate explicit policy. Sockets, devices, and named pipes are inventory-only unless a future format safely defines them. Metadata unavailable through the selected runtime or source filesystem is recorded as unavailable rather than synthesized. Restore maps identities and timestamps only where the destination supports them, preserves original metadata in the manifest regardless, and reports every lossy application.

`inventory.jsonl` records one decision per candidate, including excluded candidates. Each decision has a rule ID and reason such as `included:user-approved`, `excluded:secret-pattern`, `excluded:size-limit`, `metadata-only:binary`, or `failed:permission-denied`. This makes negative evidence and collection gaps visible.

### 5.3 Human and machine views

`sessions.json` is the complete machine-readable catalog for all locally stored sessions found in the selected Claude project directory. It records the session ID, display title or best factual fallback, timestamps, message counts, recorded models/branches/Claude versions/entrypoints, recorded working directories, related subagent/tool-result counts, transcript path, and direct resume command. The same session list appears in `capture-report.json`, `capture-report.md`, and `capture-report.html`; reports are allowed to contain sensitive prompt/title text because the canonical capsule is secret-bearing.

`capture-report.json` is the integration-neutral, canonical machine-readable capture report. `capture-report.md` and `capture-report.html` are human-readable renderings. They are created from captured manifest/inventory/session facts only and report scope, counts, failures, validation, readiness, destination, Agent Environment Profile collection status, and every captured session without requiring semantic analysis.

For a derivative, `summary.md` is a safe-by-construction, human-readable orientation view: package purpose, project state, major findings, work in progress, unresolved questions, restore cautions, redaction summary, and validation result. It must not be the sole source of truth and is never written back into the canonical capsule.

`observations.json` is the normalized machine-readable view. Records include:

- repository identity, current branch/HEAD, worktree state, remotes with credentials removed, submodules, and relevant worktrees;
- languages, build/test/package tools, project entry points, documented commands, and detected configuration;
- changed/untracked/generated/temporary artifacts and their relationships;
- session timeline, stated goals, decisions, completed actions, failures, open tasks, and referenced files;
- agent memory records with source, scope, timestamps when known, and confidence;
- evidence links back to manifest entry IDs and source ranges;
- uncertainty and conflict records rather than silently choosing one account.

Observations are descriptive, not executable instructions. Imported text is always treated as untrusted data.

Session inspection exposes the captured history as evidence and may show model/provider identifiers only when recorded in source artifacts. Absence is reported as `not-recorded`, not inferred. Derived session summaries link to source capsule ID, entry IDs/ranges, analyzer identity/version, runtime, policy, parameters, and creation time.

`project-snapshot.html` is the static human-facing Project Snapshot/report. It is a validated derivative with no remote resources or executable scripts. It renders the package summary, repository observations, readiness, and a privacy-safe Agent Environment Profile section. Each profile record uses a neutral agent label plus its source adapter (for example, agent `Claude Code`, adapter `claude-code`) rather than embedding platform-specific semantics in the layout. Values are HTML-escaped, secret-redacted, and linked to logical evidence references rather than local absolute paths. The HTML view is never authoritative; machine-readable records and evidence remain the source of truth.

### 5.4 Agent Environment Profile

`agent-environment-profile.json` records evidence about how Claude Code could or did drive the selected project. It is provenance, not an instruction set: consumers must not install, connect, authenticate, invoke, or trust a skill, MCP server, API, command, URL, or integration because it appears in the profile.

The schema is integration-neutral even though Claude Code is the first adapter. Every record identifies its `agentLabel` and `sourceAdapter`; a future Codex adapter maps Codex-native instructions, skills, MCP facts, and scoped session evidence into the same kinds, state vocabulary, evidence references, and privacy rules. Cross-agent consumers use normalized records only and never parse or execute the other agent's native configuration. Platform-specific fields, if unavoidable, live in a namespaced evidence extension and cannot change common semantics.

The canonical capsule always contains a versioned profile envelope with `collectionStatus` (`complete`, `partial`, `deferred`, or `unavailable`), collection policy, source scope, and findings. Direct, privacy-safe facts may be collected during capture from already in-scope first-class project evidence such as `AGENTS.md`, `CLAUDE.md`, project-scoped `MEMORY.md`, `README` files, manifests, sanitized configuration templates, source imports/calls, and scoped session/log evidence. If safe collection would require semantic analysis, secret-bearing configuration reads, a user-global sweep, or an unavailable adapter, the canonical envelope records `deferred`/`partial` and evidence candidates; a later immutable analysis derivative supplies the profile without modifying the capsule.

The minimal default record for each discovered item contains only:

- kind: `skill`, `mcp-server`, `api`, or `integration`;
- normalized display name and stable non-secret identifier when available;
- version when directly recorded, otherwise `unknown`;
- origin and scope (`project-file`, `project-session`, or specifically opted-in `user-global`), with project association;
- declared capability categories as evidence-backed labels, never executable permissions;
- state/usage classification and confidence;
- evidence references to manifest entry IDs and source ranges, plus collector/parser version.

Project-scoped and user-global facts are separate arrays and are never merged. Project-scoped facts are the default. A user-global Claude skill, MCP configuration, or integration may be considered only through deliberate per-artifact opt-in under Section 7; unrelated global configuration is neither read nor summarized.

State vocabulary prevents capability presence from being mistaken for use:

- MCP records carry independent `installed`, `configured`, and `observed-in-session` evidence facets, with `unknown` where a facet cannot be established. An MCP may be installed but not configured for this project, or configured but never used; neither state may be rendered as observed use. `observed-in-session` requires an evidence-bearing scoped session/tool record.
- API/integration records distinguish `declared-in-project`, `observed-in-log-or-session`, `declared-and-observed`, and `unknown`. A README, dependency, import, template, or environment-variable name establishes declaration/dependency evidence only, not successful calls or account access.
- Skill records distinguish `installed-project-local`, `declared-for-project`, `observed-in-session`, combinations supported by evidence, and `unknown`; presence in a global install location alone does not establish project relevance. A deliberately opted-in global skill remains global-scoped even when project evidence refers to it.

The profile never contains or displays secrets, access/refresh tokens, API keys, cookies, connection strings, authorization headers, private endpoints when classified sensitive, complete credential/configuration files, or raw unrelated global settings. Parsers use allowlisted fields and sanitize before persistence. Sensitive or ambiguous configuration is excluded/redacted, cited only by safe logical evidence metadata, and creates an `action-required:sensitive-agent-environment-config` finding. A redacted value cannot be reconstructed from hashes, snippets, HTML attributes, error text, or logs.

### 5.5 Four package types

#### Forensic backup / canonical migration capsule

This is the primary and authoritative backup artifact. It is both a highest-fidelity evidence capture and a restorable Claude Code project migration capsule, intended for loss prevention, investigation, reprocessing, and faithful recreation on another Mac. Product UI and documentation must call this the canonical migration capsule; `forensic-backup` may remain the stable schema type identifier.

- Must target fidelity class F0 and capture the complete declared scope: every working-tree file; repository and Git administrative state needed to reproduce the captured branch, HEAD, index, refs, submodule/worktree relationships, ignored/untracked files selected by scope, and uncommitted changes; raw Claude Code project/session/memory artifacts; relevant settings/logs; scoped temporary/generated files; and environment metadata.
- Records tool/runtime/dependency state such as macOS and architecture, Claude Code/core/adapter versions, selected Bun or Node runtime, package-manager and lockfile facts, installed dependency metadata when policy permits, relevant tool versions, environment variable names with values separately protected, and machine-specific assumptions. It does not claim that recorded facts alone reproduce an external service.
- Preserves original bytes when permitted, timestamps and mode bits where available, discovery failures, and full inclusion decisions.
- Must contain `restore-readiness.json`. If any requested item is inaccessible, unstable, excluded, or nonportable, the capsule remains the canonical source capture but is marked `action-required` or `not-ready`, never falsely `ready` or fully faithful.
- Is classified **secret-bearing by default**, because source code, Git history, logs, and agent artifacts can contain undetected secrets. Every capture report and store-transfer flow must warn that the capsule requires confidential storage and transfer even when scanners find nothing.
- Defaults to local-only and restrictive filesystem permissions. Until an authenticated encryption envelope and key-management design are implemented and tested, known credentials and credential stores cannot be captured at all. Their exclusion is mandatory and creates explicit `action-required` findings, reconciling the F0 target with the authorized declared scope rather than silently weakening it.
- Is the immutable parent of project context, shareable, and restore-package derivatives. Derivatives are regenerated from it and cannot supersede it.
- Raw content is not automatically placed in an agent prompt; faithful storage and model-context disclosure are separate decisions.

#### Project context

A curated, potentially lossy derivative for resuming work in the same trust boundary.

- Prioritizes current goals, decisions, repository observations, relevant session excerpts, agent memory, working-tree evidence, generated outputs needed for continuity, and validation commands.
- Omits unrelated logs, caches, raw telemetry, and redundant artifacts.
- May retain private project information but should exclude secrets by default.
- Is suitable as input to a local Codex or Claude Code adapter after validation.

#### Shareable package

A minimized, deliberately lossy derivative intended to cross a person, team, machine, or organizational boundary.

- Requires an explicit audience/purpose and a stricter allowlist policy.
- Removes credentials, tokens, cookies, private keys, environment values, personal paths, account IDs, unnecessary prompts/transcripts, and repository remote credentials.
- Includes a redaction report describing classes and counts without reproducing secret values.
- Rewrites or pseudonymizes identifiers consistently when usefulness requires linkage.
- Must be regenerated from source evidence when policy changes; manual deletion inside an archive is not a trustworthy sanitization process.
- Must identify its canonical parent and prominently state that it is not a backup and cannot establish full restore readiness.

#### Restore package

An action-oriented, target-specific derivative of the canonical capsule containing a validated restore plan plus only the artifacts approved for restoration. It is a transport/execution view, not a replacement backup.

The dry-run plan conforms to the versioned `restore-plan.schema.json` contract. Its schema identity/version is embedded in every plan, and readers reject unsupported major versions. Version 1 is the implemented Part 1 contract; implementations must not substitute ad hoc console prose for the machine-readable plan.

- Declares the expected target agent, adapter version range, project identity constraints, and preconditions.
- Contains operations such as `copy-new`, `merge-structured`, `present-context`, or `skip`; it never relies on arbitrary embedded scripts.
- Includes expected pre-state hashes where an existing file may be touched, conflict behavior, and rollback metadata.
- Defaults to restoring into a staging directory or a new Git worktree. In-place writes require explicit approval after a dry run.
- Separates repository files from agent-local state so either portion can be declined.

### 5.6 Fidelity classes and restore readiness

Every package declares one fidelity class:

- **F0 — canonical full-fidelity:** byte-preserving source data and reconstruction metadata for the complete declared scope. Only the canonical migration capsule may claim F0. F0 describes the capture target; `restore-readiness.json` determines whether gaps prevent a faithful restore.
- **F1 — restorable derivative:** target-specific content sufficient for the declared restore plan, but possibly omitting evidence irrelevant to that target. Restore packages normally use F1.
- **F2 — contextual derivative:** selected evidence and normalized observations for continuation or analysis. Project context packages normally use F2.
- **F3 — shareable/minimized:** audience-scoped, redacted, pseudonymized, or summarized content. Shareable packages use F3.

Lower-fidelity derivatives must point to the canonical capsule's package ID and manifest digest. No F1–F3 artifact, even if easier to use, may be presented as a complete backup. Derivation never mutates the canonical capsule.

`restore-readiness.json` is machine-readable and has a corresponding section in the canonical `capture-report.md` and any later restore-oriented `summary.md`. It records:

- overall status: `ready`, `action-required`, or `not-ready`;
- assessed source and target platform/architecture, Claude Code and adapter compatibility, and project identity;
- coverage by required domain: working tree, Git state, Claude Code project/session/memory state, generated/temporary scope, configuration, and tool/runtime/dependency environment;
- unavailable, unreadable, unstable, intentionally excluded, redacted, transformed, and nonportable entries with inventory references;
- machine-specific paths, symlinks, filesystem semantics, platform-bound binaries/native modules, licenses, and external dependencies;
- secrets intentionally not copied, external-service credentials or accounts that cannot be transferred automatically, and the exact user reauthentication/reconfiguration action required without exposing values;
- required installations, version mismatches, target path mappings, conflicts, and post-restore verification steps;
- a reasoned fidelity assessment and blockers that prevent a `ready` result.

Integrity and readiness are distinct: a capsule can be byte-perfect and still require user action because a credential, provider-side session, licensed tool, unavailable artifact, or architecture-specific binary cannot or must not be migrated automatically.

Readiness is also domain-scoped. `repositoryData`, `gitState`, `filesystemMetadata`, `agentState`, `agentEnvironment`, `credentials`, and `externalServices` each receive their own status before aggregation. `gitState` must be `ready` for Git-backed sources and `not-applicable` for folder sources. An `action-required` agent/credential finding does not block a verified Part 1 project restore when `repositoryData` and the applicable Git contract are satisfied; reports must show that distinction and must not relabel the whole capsule fully ready.

## 6. Capture lifecycle

1. **Choose:** the user selects the Claude Code project and explicitly chooses or creates the destination capsule-store root. Validate the store without modifying the project or current agent state.
2. **Identify:** resolve the project root, Git identity, requesting agent, purpose, and canonical capture policy.
3. **Discover:** adapters enumerate the full declared scope: the working tree and Git state, Claude Code session/memory/project artifacts, temporary/generated files, settings/logs, environment facts, and related repository evidence. Discovery is read-only and records inaccessible locations.
4. **Classify:** assign artifact kind, ownership, sensitivity, trust, size, and retention class. Detect symlinks and prevent traversal outside approved roots unless separately authorized.
5. **Plan:** apply the canonical capture policy and produce an inclusion/exclusion preview with size and risk estimates.
6. **Approve:** the confirmed capture command authorizes the declared repository and Claude-state roots as one operation; no additional per-artifact privacy approval is required.
7. **Collect:** copy into a private staging directory under the chosen store without executing repository or artifact content. Preserve originals and record read-time races or mutations.
8. **Preserve:** write the canonical capsule. Redaction/minimization applies to derivatives or to items explicitly excluded by the canonical capture policy; every exception becomes a readiness finding. Transform a copy, never the source.
9. **Package:** canonicalize the manifest, hash final stored bytes, and write the inventory, factual JSON/Markdown/static-HTML capture reports, Agent Environment Profile envelope, restore-readiness assessment, redaction report, and validation inputs. No session summarization, repository interpretation, or model call is required.
10. **Validate/finalize:** independently reopen the staged capsule, validate schema, inventory closure, hashes, path safety, provenance, and policy assertions, then atomically move it to `capsule/<capsule-id>/`. Nothing is written alongside the capsule container.
11. **Return:** report the capsule ID, chosen store path, validation/readiness status, and known gaps. Offer analysis or derivation as follow-on actions rather than extending the capture operation.

If source bytes change while being read, capture retries once and otherwise records both the inconsistency and a partial result. A package may not claim `complete` when requested evidence was inaccessible or unstable.

### 6.1 Live-capture consistency contract

Capture is a bounded best-effort snapshot of a live project, not an atomic snapshot of macOS. Before capture, the plugin asks the user to quiesce edits, stop Git operations, and pause Claude Code activity for the selected project when feasible. Declining does not necessarily block capture, but it raises the consistency risk recorded in readiness.

The manifest records a monotonic/wall-clock capture start and end, per-entry observation/read times, and source fingerprints. The core takes pre- and post-capture observations where safe: working-tree directory metadata; Git HEAD, refs, index identity, worktree status, and relevant administrative files; and sizes/mtimes/inodes (where available) of Claude artifacts. Differences, Git lock appearance, HEAD/index/ref movement, directory churn, or Claude-file rewrites produce named consistency findings. The tool retries only bounded individual reads; it never loops indefinitely waiting for a live session to settle.

For a recognized append-only session file, capture records the size at the start of its read and copies at most that stable prefix, subject to configured per-file/total byte and time limits. It hashes the prefix, records observed start/end sizes and trailing bytes not captured, and marks `action-required:live-append` when growth occurred. If the prefix itself changes, the format is not known to be append-only, limits are exceeded, or truncation/replacement occurs, the item is marked unstable/partial and may be retained as a bounded forensic read with an explicit readiness finding. Capture never claims a coherent cross-file Claude session transaction unless an adapter provides and passes a documented snapshot mechanism.

### 6.2 Deferred and repeatable analysis

Analysis is never a capture prerequisite and may run immediately, later, repeatedly, or on another computer after the store is transferred. Failing, cancelling, or lacking a model for analysis cannot invalidate or delay an otherwise valid canonical capsule.

An analysis operation:

1. validates the selected capsule and reads its canonical payload without modification;
2. records the analyzer/core/adapter versions, selected Bun or Node runtime, model/provider identifiers when an analysis model is used, prompt/policy version, parameters, start/end time, and exact parent manifest digest;
3. produces a new immutable derivative under `<capsule>/derivatives/<derivative-id>/` containing `analysis.json`, appropriate `observations.json`, an analyzed `agent-environment-profile.json` when requested, and human-readable Markdown/HTML summaries;
4. links every derived claim to source evidence where possible and labels inference, conflict, missing evidence, and confidence;
5. validates the derivative and records it only within its owning capsule.

Re-analysis with a newer parser, policy, or model creates a sibling under the capsule's `derivatives/` directory; it never updates the canonical payload or overwrites an earlier analysis. Users can compare derivatives and select one for follow-on context/shareable/restore actions. Repository observations, package summaries, and derived session summaries are analysis outputs unless they are direct capture facts.

### 6.3 Core user flows

1. **Capture to a chosen folder:** invoke the plugin's capture/backup skill, select the Claude Code project, choose or create a destination root, review scope/readiness implications, and receive one finalized capsule folder and report.
2. **Transfer a capsule:** copy or zip the complete `<capsule-id>/` folder. It has no dependency on files elsewhere in the chosen root.
3. **Open a capsule:** point the plugin or portable CLI directly at the transferred capsule and validate its manifest and payloads.
4. **Analyze separately:** select an existing capsule and run a versioned analysis without recapturing or modifying it.
5. **Inspect evidence and results:** browse captured session history; model identifiers where actually recorded; derived session summaries; package/capture summaries; repository observations; inventory, validation, and readiness findings. Raw sensitive content is revealed only on an explicit, policy-allowed request.
6. **Continue with follow-on actions:** select a canonical capsule and optionally a trusted analysis derivative, then create a project-context/shareable/restore package or execute an approved restore workflow.

## 7. Claude Code evidence discovery

Claude Code artifact layouts and formats may change. The Claude Code adapter therefore owns a versioned set of locators and parsers rather than embedding assumed paths in the core. The default scope is **project-scoped only**: artifacts must be attributable to the selected project by location or validated internal project identity. User-global history, memory, instructions, settings, logs, caches, and account state are excluded by default. Each user-global artifact requires a deliberate, per-artifact opt-in with a preview, reason, sensitivity classification, and inventory decision; a blanket “include my Claude directory” choice is not permitted.

The explicit source path is authoritative for Claude session ownership. The adapter first checks the exact path-derived Claude project key. A fallback project key is eligible only when a structured transcript record has a `cwd` equal to the selected source path, including the equivalent macOS `/private` path form. A source path appearing only in prompt text, tool input, output, or other transcript content is not project-identity evidence and must not cause that transcript directory to be captured. If no eligible Claude project directory exists, capture stops instead of substituting sessions from the invoking agent's current or parent working directory.

Candidate project-scoped evidence includes:

- first-class project instructions and documentation such as `AGENTS.md`, `CLAUDE.md`, project-scoped `MEMORY.md`, `README` files, manifests, configuration templates, and relevant source evidence used to populate the Agent Environment Profile;
- project-scoped memory/instruction artifacts, plus individually opted-in user-global artifacts;
- session transcripts, checkpoints, summaries, task state, and referenced attachments when locally available;
- settings and policy files, with values classified before inclusion;
- diagnostic logs and command/tool-result metadata;
- agent-created temporary files, patches, plans, generated outputs, and caches that are relevant to the project;
- repository files, Git metadata, diffs, status, ignored-file evidence, and filesystem metadata;
- tool, runtime, package-manager, lockfile, installed-dependency, operating-system, architecture, and path-mapping evidence required to assess reproducibility on another Mac.

Discovery must distinguish observed files from inferred missing artifacts. Unknown formats may be retained as opaque bytes in a forensic backup but may not be parsed or promoted into observations without a compatible parser. Settings and logs receive a high-sensitivity default because they can expose paths, prompts, command output, account details, or secrets.

### 7.1 Repository and Git safety

Source type is automatic and recorded as `source.kind`. If `<source>/.git` is absent, the source is `folder`: `git.applicable` is false, Git fields that would imply observation are null or `not-applicable`, and no Git executable is required or invoked during capture, planning, or restore. Folder mode still performs canonical byte hashing, pre/post tree-membership comparison, filesystem capability assessment, Claude-state capture, destination remapping, and post-restore content/session verification. If `<source>/.git` exists, the source is `git-repository` and the strict Git contract below applies. The implementation never silently downgrades an existing repository to folder mode because doing so could conceal lost branch, index, refs, or uncommitted-state fidelity.

Capture must not execute repository-controlled code or configuration. It does not run hooks, filters, credential helpers, aliases, fsmonitor/watchman helpers, diff/textconv drivers, submodule commands, package scripts, or binaries found in the project. Git observations use direct inert file parsing where practical; any Git subprocess uses a sanitized environment, disables optional locks and external/global configuration, overrides execution-capable settings, invokes only allowlisted built-in read operations, and is covered by hostile-repository tests. If safe observation is not possible for an installed Git version, the tool records the gap rather than running an unsafe command.

The manifest records the Git executable path/version used for observation, repository format/extensions, object format, compatibility findings, and whether state was obtained by file parsing or a command. The capture scope treats Git state explicitly:

- a normal `.git/` directory is captured as administrative data with volatile lock/socket files inventory-only; the presence of locks is a live-consistency warning;
- a `.git` indirection file and linked-worktree `commondir` are resolved only after containment/authorization checks; common-dir and per-worktree state are represented separately, and absolute path bindings are recorded for destination remapping;
- refs, packed refs, HEAD, index and extensions, config as inert data, shallow/graft/replace state, object alternates, LFS metadata, and object-store completeness are inventoried and validated; path-bound or external object locations create readiness findings and are never followed outside scope without approval;
- submodule declarations and Gitlink commits are recorded, but capture does not initialize, update, fetch, or execute submodules. An already-present submodule worktree is a separately bounded project scope; absent objects/remotes are reported as user actions;
- existing locks, in-progress merge/rebase/cherry-pick/bisect state, sparse checkout, partial clones, worktree links, and platform-specific filename conflicts are preserved or reported according to schema rather than normalized away.

Restore planning never assumes that copying `.git` blindly is portable. It chooses only a proven reconstruction strategy for the recorded repository format and destination Git version; otherwise it preserves the evidence and emits a handoff/readiness blocker.

### 7.2 Part 1 pinned Git and metadata contracts

The Node reference implementation pins the following Part 1 decisions:

- **Git reconstruction:** Part 1 supports a normal, self-contained `.git/` directory. It captures Git administrative bytes—including objects, refs, HEAD, packed refs, index, and in-progress state—without interpreting them as commands, excluding volatile lock/socket entries. Restore recreates those bytes relative to the new repository root; the index is reconstructed byte-for-byte, not regenerated from the worktree, so staged state remains distinguishable from unstaged state.
- **Path-bound Git state:** a `.git` indirection file, `commondir`, `core.worktree`, object alternates, linked worktrees, or another absolute/external administrative binding is a Part 1 capture/restore blocker. Preview reports redacted binding kinds without running Git against the bound worktree; confirmed Part 1 capture refuses before copying them. A future evidence-only mode may preserve such files, and any later dry-run/receipt must use declared variance codes such as `git-path-bound:not-applied`; it may never copy an absolute source-machine binding into an active destination repository without proven remapping.
- **Git verification prerequisite:** Part 1 does not bundle a Git parser. For `git-repository` mode, source observation and destination verification require a probed Git `>=2.39.0 <3.0.0`, with the exact path/version recorded. Commands are an allowlist of inert built-ins, use no shell, a sanitized environment, disabled optional locks/fsmonitor/hooks/global/system config, bounded output/time, and never fetch, checkout, clean, run submodules, or invoke repository-configured helpers. Missing/incompatible Git blocks Git-ready capture/restore rather than silently weakening verification. `folder` mode does not probe or invoke Git and reports the Git domain as `not-applicable`.
- **Locks and concurrency:** Git lock files are inventory-only. Their presence or pre/post changes in HEAD, refs, index, or normalized status create a consistency blocker for actual restore; the user must quiesce and recapture.
- **Hard links:** capture records source `(device,inode)` groups but stores independently verifiable bytes for every logical path. Restore attempts to recreate later members with `link()` to the first restored member. If the destination cannot create the link, it writes an ordinary byte-identical file and records `metadata-variance:hardlink-not-preserved`; repository-data integrity may pass, but metadata fidelity cannot be `ready`.
- **Node metadata allowlist:** Part 1 applies ordinary permission bits (`mode & 0o0777`) and atime/mtime to regular files and directories only. Setuid, setgid, and sticky/special bits are recorded as source facts but not applied. It does not apply source uid/gid, birthtime/ctime, symlink ownership/times, xattrs/resource forks, ACLs, or BSD flags. Node `lstat` facts remain in the manifest; capabilities not safely observable or applicable through the reference path produce explicit `unobserved`/`not-applied` findings. No external metadata tool is invoked merely to improve fidelity.
- **Atomic destination:** actual restore accepts only a nonexistent destination, holds a sibling destination lock, writes a private sibling staging directory, verifies bytes and Git state there, rechecks nonexistence, and atomically renames it into place. A pre-finalization failure leaves the requested destination absent and cleans the staging tree; a post-finalization verification failure retains the new destination for diagnosis but never overwrites a pre-existing destination.

## 8. Runtime-selection contract

### 8.1 Policy

macOS is the initial supported platform. Part 1 has one runtime path: Node.js `>=22.0.0 <23.0.0`. The CLI checks that range before an operation and records the exact executable and runtime version in generated artifacts. An unsupported runtime stops before capture, planning, validation, or restore can claim success.

Bun is not selected by the current implementation. A future Bun adapter must be explicitly versioned and capability-probed, must not trust an artifact-provided executable, and must pass semantic parity and cross-runtime transfer tests before it can become a supported execution path.

### 8.2 Portability rules

- Required core paths use the supported Node.js APIs, normally `node:fs`, `node:path`, `node:crypto`, standard streams, and covered Web APIs.
- Any future Bun-specific APIs must be isolated in a runtime adapter and have a Node implementation or be an optional optimization.
- Package schemas, hashes, canonical JSON, archive ordering, summaries, and validation results must be runtime-independent.
- Before Bun support is released, golden-package tests must run capture and validation under both runtimes and compare semantic output; cross-runtime tests must create with one runtime and validate/restore with the other.
- After transfer, validation, destination readiness reassessment, dry-run planning, and actual restore run with the supported Node.js runtime and portable core CLI without requiring Bun or the Claude Replicant plugin.
- Filesystem tests cover macOS case behavior, Unicode normalization, permissions, symlinks, extended attributes policy, and Apple Silicon and Intel distribution targets where supported.

Bun aims for broad Node.js compatibility and runs many Node test-suite cases, but its own documentation describes compatibility as ongoing rather than complete. Compatibility therefore reduces implementation duplication; it does not replace testing. See [Bun's Node.js compatibility status](https://bun.com/docs/runtime/nodejs-compat) and [Bun runtime design goals](https://bun.com/docs/runtime).

### 8.3 Packaging and distribution

Development uses a lockfile and reproducible dependency installation. Release artifacts should include:

- a Claude Replicant plugin manifest and user-facing skill/command definitions that call the stable core contract;
- signed/notarized macOS CLI distributions for Apple Silicon and Intel as supported;
- a Bun-optimized standalone executable where release testing confirms behavior;
- a portable JavaScript distribution that runs on the supported Node.js fallback;
- a store-transfer form of that portable Node CLI and schemas so destination validation and restore planning do not depend on a plugin installation;
- schema files and compatibility metadata that can be inspected without executing captured content;
- checksums and a software bill of materials for each release artifact.

Bun ships as a single executable and documents verification through `bun --version` and `bun --revision`; these are discovery inputs, not sufficient health checks by themselves. Bun can also create standalone executables containing the runtime, and documents separate macOS architecture targets. Those features are useful for distribution, but resulting binaries still require platform-specific CI, signing, notarization, and end-to-end package compatibility tests. See [Bun installation and verification](https://bun.com/docs/installation) and [Bun standalone executables](https://bun.com/docs/bundler/executables).

## 9. Integrity and provenance

Validation is independent of capture and can run offline.

- SHA-256 is the baseline digest over the exact stored bytes of every payload and report; the manifest itself receives a package-root digest using a defined canonicalization procedure.
- Every referenced payload must exist exactly once, and every payload must be referenced. Duplicate logical paths, absolute paths, `..`, unsafe symlinks, device files, sockets, and archive traversal are rejected. The platform-metadata exception is limited to regular files with the exact basename `.DS_Store`: an unreferenced instance added after finalization emits `ignored-unreferenced-platform-metadata`; a legacy manifest entry that was not Git-tracked emits `ignored-manifest-platform-metadata`. Neither form is restored, and validation leaves the manifest and payload untouched. A directory, symlink, or Git-tracked file with that name is not exempt.
- Capture excludes untracked regular `.DS_Store` files as platform metadata and omits them from expected restored Git status. A tracked `.DS_Store` remains canonical repository content and is hash-verified like any other referenced payload.
- Derived packages record parent package IDs, parent manifest digests, derivation policy, transformation tool version, and source-to-output lineage.
- Validation distinguishes **integrity** (bytes match), **authenticity** (optional trusted signature), **policy compliance** (declared rules passed), and **safety** (never guaranteed by hashes).
- A validator emits `validation.json` with errors, warnings, validated schema range, and timestamp. Invalid packages are not passed to an agent or restore executor.
- Optional signatures and timestamping are a later phase; unsigned packages must be clearly labeled.

## 10. Security and privacy

### 10.1 Threat model

Captured content may contain malicious instructions, path traversal, symlinks, executable payloads, prompt injection, secrets, personal data, proprietary source, or poisoned metadata. The source workspace may also change during capture. Package consumers and originating agents may have different trust boundaries.

### 10.2 Controls

- Local-only operation and no network access are the default capture posture.
- Captured text is data. The core and integrations never treat instructions inside transcripts, logs, READMEs, or packages as authority to execute tools or alter policy.
- Secret detection combines exact known-secret sources, high-confidence patterns, entropy heuristics, structured parsers, and user-defined rules. Values are never printed in reports.
- Redaction occurs before final hashing, and lineage records the transformation without retaining the removed value.
- Keychains, SSH/GPG private keys, cloud credentials, cookies, browser state, authentication databases, and credential values are unconditionally denylisted until an authenticated encryption envelope exists. Explicit approval alone is insufficient in the pre-encryption phases. Environment/configuration files are scanned and may be excluded or captured only according to field-level/file-level policy; every credential exclusion is inventoried and makes restore `action-required` when relevant.
- Credentials and external accounts are never assumed portable. After an encryption envelope exists, any narrowly scoped credential capture will still require explicit authorization, separate restore consent, and compliance with macOS Keychain, provider, licensing, and organizational controls. The normal migration path records the dependency and prompts the user to reauthenticate or reconfigure it on the destination Mac.
- Binary content defaults to metadata-only outside forensic backups unless allowlisted and scanned.
- Output directories use restrictive permissions; temporary staging is private and cleaned after successful atomic finalization. Crash recovery exposes and safely cleans abandoned staging areas.
- Limits on entry count, file size, total size, decompression ratio, nesting, and parse time defend against resource exhaustion.
- Restore never runs package content, lifecycle scripts, Git hooks, agent hooks, or validation commands automatically.
- Shareable packages require a second validation pass after redaction and should support a user-visible preview of all included logical paths.
- Canonical capsules always display secret-bearing storage/transfer warnings and default to restrictive creation modes. Secret scanning reduces risk but never downgrades that classification or represents proof of absence.

Redaction is not a proof that data is anonymous. The summary must state the applied policy and residual risks, especially when source code or conversational context can identify people or organizations indirectly.

## 11. Restoration and cross-agent use

Restoration has two ordered stages: faithful data reconstruction first, then Claude Code reconnection and contextual continuation. Agent setup must never run ahead of verified project restoration.

1. Using the portable core under a supported Node.js runtime if the plugin/Bun are absent, validate the canonical capsule's integrity, schema support, provenance, fidelity class, and `restore-readiness.json`; verify that any restore package is a valid derivative of that capsule.
2. Perform a new destination-side readiness assessment; source-time readiness is evidence, not authorization to restore elsewhere. Probe the destination Mac, architecture, filesystem capabilities, filename collisions/normalization, target path, Git/Claude Code/tool compatibility, installed runtimes, and existing repository state. Write a new derivative assessment without changing the capsule, and stop or request decisions for blockers.
3. Produce a dry-run plan listing creates, exact copies, metadata restoration, Git reconstruction, path remapping, dependency/tool setup, conflicts, skips, Claude Code state writes, privacy implications, and user actions.
4. Restore the project data into a staging directory first: working-tree bytes and permitted metadata, then Git administrative state, refs/index and captured uncommitted changes, then scoped generated/temporary artifacts and relevant configuration. Do not run repository code, package lifecycle scripts, hooks, or binaries.
5. Verify restored content and Git state against the inventory and expected hashes. Confirm branch/HEAD/index/worktree status and enumerate every variance. Promote to the requested location only after approval; never overwrite an existing project silently.
6. Recreate the recorded tool/runtime/dependency environment where safe and authorized. Prefer lockfiles and recorded versions, but treat installation as a separate approved action because it may execute third-party code or require network access. Platform-bound binaries must be rebuilt or reacquired for the destination architecture rather than blindly reused.
7. After project data passes verification, restore captured Claude Code filesystem state into a new, nonexistent isolated Claude home. Preserve the canonical payload bytes, then rewrite only the restored copies of path-bound Claude transcripts/configuration from the source project path/key to the destination path/key. Record both source and restored digests, verify every restored entry, and return the exact `CLAUDE_CONFIG_DIR` activation value. Never merge into or overwrite an existing Claude home in Part 1.
8. Ask the user to reconnect Claude Code and reauthenticate external services, source hosts, registries, or licensed tools. Never copy, activate, or infer credentials/accounts without specific authorization; verify access without recording new secret values.
9. Give Claude Code the validated project summary plus appropriate normalized observations and evidence references so it can continue with comparable context. “Comparable” does not promise identical hidden/provider-side model state.
10. Run non-executing structural checks by default. Native-resume readiness succeeds only when every cataloged transcript exists at `projects/<encoded-destination>/<session-id>.jsonl`, parses as JSONL, contains its session ID, and contains the destination `cwd`. Emit JSON, Markdown, and HTML restore reports inside the capsule's `operations/` directory with capsule/derivative digests, target identity, operations, conflicts, variances, source/restored hashes, runtime, adapter version, per-session checks, the picker command, direct resume commands, reconnection status, and outstanding user actions.

For Claude Code, the Part 1 adapter reconstructs the captured local filesystem state under an isolated `CLAUDE_CONFIG_DIR` after repository verification. Interactive sessions should appear in Claude Code's native resume picker; sessions created through print mode or the Agent SDK may require `claude --resume <session-id>` even when the transcript is valid. Authentication is destination-machine state and may need to be established again. For Codex, a later adapter will provide normalized context through its task/workspace surfaces. Neither adapter impersonates the other agent's private or provider-side state.

Cross-agent summaries distinguish sourced facts, agent-authored decisions, tool outcomes, and inference. Evidence references let either agent request the smallest relevant artifact. Context-budget selection is deterministic and policy-aware so changing agents does not silently change the disclosure boundary.

### 11.1 Comparable-context acceptance

The compatibility fixture tests a synthetic Claude Code project captured at one path and reconstructed at a different absolute path with an isolated Claude home. It inventories project-bound and path-bound artifacts, proves byte-level reconstruction and project-key remapping, and never writes into an existing real user Claude home.

“Comparable context” is accepted when, from the restored project plus allowed handoff material, a fresh Claude Code session can, without access to the source machine:

- identify the project, current branch/HEAD, captured uncommitted/untracked state, and integrity/readiness gaps;
- state the last recorded goal, completed work, material decisions, unresolved tasks, and referenced files with provenance;
- list every selected-project captured session in JSON, Markdown, and HTML reports, locate its transcript and model identifiers where actually recorded, and provide its direct resume command without inventing missing metadata;
- propose the next documented action while preserving uncertainty and without requiring native hidden/provider state;
- pass structural inventory/Git comparisons defined by the fixture, apart from declared destination-specific metadata differences;
- pass the per-session native-resume layout checks under the isolated destination `CLAUDE_CONFIG_DIR`.

The acceptance record is human-reviewed and machine-assisted; model wording need not match. Part 1 restore must fail rather than claim success when any cataloged session fails the native-resume layout check. A future F2 project-context handoff may still be generated as a separate derivative, but it is explicitly not native session restoration and does not satisfy this Part 1 requirement.

## 12. Validation strategy

- JSON Schema tests for every package and normalized observation version.
- Golden fixtures for all four package types, including partial and redacted captures.
- Capsule-folder tests for user-selected destinations, atomic finalization, absence of store-level sidecars, in-capsule plans/receipts/derivatives, relative-path portability, and independent validation.
- Deferred-analysis tests proving capture completion has no analysis/model dependency and repeated analyzers create immutable, fully provenanced sibling derivatives without changing canonical hashes.
- Agent Environment Profile fixtures proving project/global scope separation; configured-versus-observed MCP states; declared-versus-log-observed APIs; project-relevant skill evidence; unknown/unavailable behavior across Claude Code and Codex adapters; stable evidence references; safe HTML rendering; and non-disclosure of seeded tokens, connection strings, sensitive endpoints, and credential-file content.
- Fidelity/readiness fixtures proving that omissions, secrets requiring reauthentication, machine-specific paths, platform-bound binaries, and unsupported Claude Code state cannot incorrectly receive `ready` status.
- Cross-runtime parity: Bun-created/Node-validated, Node-created/Bun-validated, and equivalent restores.
- Adapter contract tests using synthetic Claude Code and Codex artifacts; real private session data is never committed as fixtures.
- Mutation tests for hashes, missing/extra entries, forged provenance, and stale expected pre-state.
- Security fixtures for traversal, unsafe symlinks, archive bombs, prompt injection, malicious filenames, malformed encodings, secret leakage, and hostile logs.
- macOS integration tests across supported architectures and filesystem scenarios.
- Restore idempotence, dry-run accuracy, conflict handling, rollback, and no-execution tests.
- Cross-Mac migration tests that reconstruct working-tree bytes, Git refs/index/uncommitted state, scoped generated artifacts, and compatible Claude Code state before reconnection.
- Distribution tests for signed/notarized binaries and the Node fallback artifact on clean machines.

A release is blocked if either runtime produces a package the other cannot validate, if capture depends on semantic/model analysis, if analysis changes a canonical capsule, if a derivative is presented as the canonical backup, if a readiness report conceals a known fidelity gap, if a shareable fixture leaks seeded secrets, or if restore modifies an unapproved path.

### 12.1 Minimum end-to-end acceptance fixture

The first conformance fixture is a synthetic macOS project with:

- a Git repository containing commits, a non-default branch, staged and unstaged changes, an untracked file, an ignored generated item, and an in-progress/path-bound state case represented safely;
- a relative symlink and an out-of-scope or absolute symlink that must be reported rather than followed;
- a Unicode filename with recorded code points/normalization and a case-collision candidate for destination assessment;
- a fake credential in a denylisted fixture file that must be excluded without its value appearing in any report, plus an `action-required` readiness finding and secret-bearing capsule warning;
- scoped synthetic Claude project/session/memory artifacts, including realistic session IDs, `cwd`, titles/prompts, timestamps, entrypoints and model identifiers; one append-only session file grown by a controlled helper writer with fixed content, synchronization barriers, a bounded write count, and bounded timing relative to capture; and no real user-global Claude data;
- synthetic `AGENTS.md`, `CLAUDE.md`, project `MEMORY.md`, `README`, manifest/template, source, and session/log evidence that yield one project skill, one configured-but-unobserved MCP, one observed MCP, one declared-but-unobserved API, and one log-observed API without persisting the seeded fake connection string/token;
- deterministic modes/timestamps and synthetic xattr/ACL/flag metadata where the test filesystem supports them, with unsupported cases asserted as explicit findings.

A second conformance fixture is an ordinary folder with no `.git` entry and a matching synthetic Claude session. It must complete preview, capture, validation, planning, restore, destination remapping, and native resume verification when the requested Git executable is nonexistent and executable discovery is unavailable through `PATH`. Its manifest and receipts must report Git as `not-applicable`, and the restored destination must not acquire a `.git` entry.

The test captures to a separate chosen store, validates manifest closure and every content hash, confirms ignored/untracked/Git/symlink/Unicode decisions, generates `sessions.json` plus JSON/Markdown/HTML session reports, and generates a dry-run restore plan for a different absolute path. A deliberately corrupted payload must fail validation and be refused before any restore write. The valid capsule is then transferred/copied to a clean environment where only a supported Node.js runtime and portable core CLI are available—no Bun and no plugin—and must pass integrity validation plus destination readiness reassessment. After explicit test approval, the tool executes the plan into a new isolated target, emits JSON/Markdown/HTML restore reports, verifies included canonical file hashes, audits destination-remapped agent hashes, verifies supported metadata/symlinks, branch/HEAD/refs/index, staged/unstaged status, declared untracked/ignored items, and requires every cataloged session to pass the native-resume path/session-ID/destination-`cwd` checks. Authentication and an actual provider-backed model turn remain outside this synthetic fixture.

## 13. Versioning and compatibility

Schemas use semantic versions. Readers reject unsupported major versions, tolerate documented additive minor fields, and preserve unknown fields when transforming where possible. Adapter compatibility is separate from package-schema compatibility because agent artifact formats may change independently. Migrations are pure, versioned transformations that emit a new derived package and never mutate the only copy.

## 14. Phased roadmap and implementation state

### Part 1A — evidence, contracts, and threat model (complete)

- The capsule, restore-plan, session-catalog, integrity, readiness, Git safety, and secret-exclusion contracts are defined and implemented.
- The supported reference runtime is Node.js `>=22.0.0 <23.0.0`; the runtime version is recorded in generated artifacts.
- The synthetic source-to-destination fixtures cover corruption, live append, credential exclusion, strict Git state, Git-free folder mode, path remapping, multiple sessions, and native-resume layout.

### Part 1B — portable capture and restore (complete)

- The Node.js CLI captures project and Claude state into one independently movable capsule, auto-detects Git-repository versus ordinary-folder mode, validates hashes, plans restore, and restores only to new isolated destinations after explicit approval.
- Capture produces JSON/Markdown/HTML reports and `sessions.json`; restore produces JSON/Markdown/HTML receipts inside the same capsule.
- The adapter captures all locally stored sessions in the selected Claude project directory and relevant local memory, agent, plugin, plan, task, history, settings, and cache state while excluding dedicated credential stores.
- In the standard `~/.claude` layout, home-level `~/.claude.json` is the authoritative adjacent global configuration. If a shadow `.claude/.claude.json` also exists, the adapter must not map both files to the same logical path. A custom `CLAUDE_CONFIG_DIR` uses its own root-level `.claude.json` and does not import an unrelated adjacent file.
- Restore preserves canonical bytes, remaps only restored path-bound state, verifies every remapped file, and requires every cataloged session to satisfy the native-resume layout contract.

### Part 1C — portability hardening (ongoing)

- Add an optional Bun implementation only after it produces semantically identical capsules and passes Bun-created/Node-validated transfer tests; Node.js remains the reference path.
- Harden APFS/non-APFS capability probing, metadata envelopes, live-write detection, inert Git observation, crash-safe staging, capsule-folder scanning, and the portable Node transfer CLI.
- Harden the already-isolated Part 1 restore path across supported Mac/filesystem combinations; keep in-place overwrite and dependency installation disabled.

### Part 1D — plugin distribution (complete)

- The same repository is distributed as a Codex and Claude Code marketplace plugin while retaining the standalone CLI.
- The capture skill treats the confirmed invocation as authorization for the declared repository and Claude-state roots and does not add per-artifact privacy prompts.
- Plugin installation does not capture, inspect, or inject capsule content automatically; capture, validation, planning, and restore remain explicit operations.

### Part 2 — analysis and gold-standard capsules (planned)

- Implement repeatable semantic analysis derivatives, session/model-identifier inspection, repository observations, F2 project-context packages, and F3 shareable packages.
- Establish reviewed Claude Code capsules as provenance-backed gold-standard context for evaluating, grounding, or training other agents.
- Add cross-agent continuity through normalized evidence without treating one agent's hidden state as portable to another.
- Keep every derivative within its owning capsule and preserve the canonical Part 1 payload unchanged.

### Later extensions — protected distribution and advanced restore

- Design and implement authenticated encryption and key management before allowing credential capture; later add package signing, notarization, SBOMs, update verification, and retention tooling.
- Consider advanced conflict handling, rollback, and separately approved in-place promotion only after stronger safety gates pass.
- Produce tested macOS Bun standalone binaries only after portable Bun/Node parity; retain the plugin-free Node.js distribution.
- Consider remote storage, team policy services, and additional adapters only after local capture/validation/restore contracts are stable.

## 15. Open design decisions

- Archive container and deterministic metadata rules (for example, tar versus ZIP).
- Encryption envelope and key-management integration for forensic backups.
- Signature trust model and organizational policy distribution.
- Exact supported Bun and Node.js version ranges for the first release.
- Which Claude Code and Codex local artifact versions can be restored natively rather than represented as handoff context.
- Retention defaults and secure deletion guarantees on APFS.
- Capsule-root locking and concurrent-writer policy without shared persistent metadata.
- Deterministic single-capsule archive layout without a synthetic store wrapper.

These decisions do not alter the core invariants: one standalone, portable package model and shared core, agent-specific behavior confined to thin versioned adapters, and an immutable F0 migration capsule that remains authoritative over every lossy derivative.

## 16. Bun source references

- [Installation and binary verification](https://bun.com/docs/installation)
- [Runtime overview and compatibility goals](https://bun.com/docs/runtime)
- [Node.js compatibility status](https://bun.com/docs/runtime/nodejs-compat)
- [Standalone executable and cross-compilation guidance](https://bun.com/docs/bundler/executables)

## 17. Specification maintenance

This document defines the current behavioral contract. User-visible release changes are recorded in `docs/CHANGELOG.md`; implementation milestones, evidence, and design decisions are recorded in `docs/DEVELOPMENT_LOG.md`.

Every implementation change that alters capsule layout, capture scope, restoration behavior, session compatibility, safety boundaries, or acceptance criteria must update this specification in the same commit. Schema-breaking changes require a new schema major version. Additive compatible changes require a documented schema minor version or an explicitly optional field. Documentation-only corrections may use a plugin patch release without changing capsule schema versions.
