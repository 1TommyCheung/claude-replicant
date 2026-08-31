# Claude Replicant

Portable, integrity-checked migration capsules for Claude Code projects and other coding agents.

> **Status:** Part 1 is ready. It provides the working repository capture, validation, restore-planning, and isolated restore foundation. Part 2—deeper analysis, richer restoration, and gold-standard cross-agent context—is planned for later.

## Overview

Claude Replicant captures a selected Git repository into an immutable, self-describing capsule. A capsule preserves the repository working tree and Git state together with an inventory, hashes, capture reports, readiness findings, and the metadata required to validate what was captured.

Each capture is finalized as:

```text
<chosen-store>/
└── capsule/
    └── <capsule-id>/
        ├── manifest.json
        ├── inventory.jsonl
        ├── payload/
        ├── capture-report.json
        ├── capture-report.md
        ├── redaction-report.json
        ├── restore-readiness.json
        └── validation.json
```

Every `<capsule-id>/` directory is independently movable and zip-ready. You can transfer one capsule by itself or archive several capsule directories together.

## What we are trying to achieve

The long-term goal is a portable, agent-independent record of a software project that can outlive a single machine, conversation, or coding-agent session.

Claude Replicant is designed to provide:

- **A canonical project record:** captured bytes, Git state, provenance, inventories, and integrity hashes remain the source of truth.
- **Safe portability:** capsules can be validated after being copied to another folder or Mac.
- **Auditable fidelity:** every inclusion, exclusion, limitation, and restore variance is recorded instead of hidden.
- **Agent independence:** Claude Code, Codex, and future agents can consume the same stable capsule contract through thin adapters.
- **A future gold standard:** later phases can turn approved Claude Code capsules into high-quality, provenance-backed context for evaluating, grounding, or training other agents.

A capsule is treated as potentially secret-bearing. Known credential files are excluded, but source code and Git history can still contain sensitive material. Store and transfer capsules as confidential data.

## Part 1: ready now

Part 1 is the tested repository-migration foundation. It currently supports:

- explicit selection of one source repository and one non-overlapping capsule store;
- read-only capture preview before any files are written;
- explicit confirmation before capture;
- a normal, self-contained `.git/` directory;
- tracked, staged, unstaged, untracked, and ignored/generated repository content;
- symlinks, hardlinks, Unicode filenames, and declared filesystem metadata limitations;
- mandatory exclusion of known credential files;
- SHA-256 inventory and manifest integrity checks;
- detection of source changes and capsule corruption;
- a versioned dry-run restore plan;
- explicit approval before restoring to a new, nonexistent destination;
- post-restore filesystem and Git verification with a restore receipt.

Part 1 does **not** capture credentials, user-global Claude data, hidden/provider-side state, or complete Claude/Codex session memory. It does not yet perform semantic repository analysis or claim to reproduce a model's internal state.

## Requirements

- macOS
- Node.js `>=22.0.0 <23.0.0`
- Git `>=2.39.0 <3.0.0`
- Codex or Claude Code for plugin-driven use

## Install in Codex

Add the GitHub repository as a marketplace, then install the plugin:

```sh
codex plugin marketplace add 1TommyCheung/claude-replicant --ref main
codex plugin add claude-replicant@claude-replicant
```

See the [OpenAI plugin marketplace documentation](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli) for the underlying marketplace workflow.

Start a new Codex task after installation so the bundled skill is loaded.

To update an existing installation:

```sh
codex plugin marketplace upgrade claude-replicant
codex plugin add claude-replicant@claude-replicant
```

## Install in Claude Code

From inside an interactive Claude Code session, add the marketplace and install the plugin:

```text
/plugin marketplace add 1TommyCheung/claude-replicant
/plugin install claude-replicant@claude-replicant
/reload-plugins
```

The equivalent terminal commands are:

```sh
claude plugin marketplace add 1TommyCheung/claude-replicant
claude plugin install claude-replicant@claude-replicant
```

See the [Claude Code plugin installation documentation](https://code.claude.com/docs/en/discover-plugins) for marketplace scopes, updates, and plugin management.

Claude Code skills are namespaced by plugin. The bundled skill can be invoked as:

```text
/claude-replicant:capture-repository
```

Only install plugins and marketplaces from sources you trust. Both Codex and Claude Code cache installed plugin files locally.

## Use the standalone CLI

The core workflow does not depend on an active agent session.

Preview a capture without writing files:

```sh
node scripts/claude-replicant.mjs capture \
  --source /path/to/repository \
  --store /path/to/capsule-store
```

After reviewing the preview, explicitly confirm capture:

```sh
node scripts/claude-replicant.mjs capture \
  --source /path/to/repository \
  --store /path/to/capsule-store \
  --confirm
```

Validate a capsule:

```sh
node scripts/claude-replicant.mjs validate \
  --capsule /path/to/capsule-store/capsule/<capsule-id>
```

Create a dry-run restore plan:

```sh
node scripts/claude-replicant.mjs plan \
  --capsule /path/to/capsule-store/capsule/<capsule-id> \
  --destination /path/to/new-repository \
  --output /path/to/restore-plan.json
```

Execute an approved restore only after reviewing the plan:

```sh
node scripts/claude-replicant.mjs restore \
  --plan /path/to/restore-plan.json \
  --approve \
  --receipt /path/to/restore-receipt.json
```

Run `node src/cli.mjs help` for the complete command summary.

## Roadmap

### Part 1 — repository capsule foundation (ready)

Capture, integrity validation, corruption refusal, dry-run planning, isolated restore, and post-restore verification for the selected repository.

### Part 2 — analysis, richer restoration, and agent gold standard (later)

1. **Analysis:** derive structured repository observations, project summaries, decisions, work in progress, session evidence, and provenance-linked context without modifying the canonical capsule.
2. **Richer restoration:** restore approved project and agent context through versioned Claude Code and Codex adapters, with explicit compatibility checks and safe handoff fallbacks.
3. **Gold-standard capsules:** establish reviewed Claude Code capsules as canonical training/evaluation material that other agents can learn from or be grounded against, while retaining source provenance, privacy controls, and measurable fidelity.
4. **Cross-agent continuity:** let different coding agents continue from the same verified project record without pretending their hidden internal states are interchangeable.

Part 2 derivatives will never replace or rewrite the canonical Part 1 capsule. Automated model training is not part of the current implementation.

## Development

Run the complete end-to-end test:

```sh
npm test
```

Run the repeatable smoke test:

```sh
npm run smoke
```

The test fixture covers capture, validation, intentional corruption, restore planning, approved restore, Git verification, credential exclusion, live writes, symlinks, hardlinks, ignored files, and Unicode paths.

## Design documentation

See [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md) for the detailed architecture, threat model, package contracts, safety rules, and phased design.
