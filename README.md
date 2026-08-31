# Claude Replicant

Portable, integrity-checked migration capsules for Claude Code projects and other coding agents.

> **Status:** Part 1 is ready. It captures, validates, and restores both the repository and locally available Claude Code memory/session/agent state. Part 2—analysis and gold-standard cross-agent context—is planned for later.

## Overview

Claude Replicant captures a selected Git repository and its locally available Claude Code state into an immutable, self-describing capsule. This includes project sessions, memory, subagents, file history, plans, tasks, skills, commands, plugins, hooks, settings, and the repository working tree/Git state.

Each capture is finalized as:

```text
<chosen-store>/
└── capsule/
    └── <capsule-id>/
        ├── manifest.json
        ├── inventory.jsonl
        ├── payload/
        │   ├── repository/
        │   └── claude-home/
        ├── capture-report.json
        ├── capture-report.md
        ├── capture-report.html
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

A capsule is secret-bearing by design. Session transcripts and agent state are captured without content redaction and can contain credentials or private information. Dedicated credential stores are excluded, but that does not make a capsule safe to publish. Store and transfer capsules as confidential data.

## Part 1: ready now

Part 1 is the tested migration foundation. It currently supports:

- explicit selection of one source repository and one non-overlapping capsule store;
- read-only capture preview before any files are written;
- explicit confirmation before capture;
- a normal, self-contained `.git/` directory;
- tracked, staged, unstaged, untracked, and ignored/generated repository content;
- Claude Code project transcripts (`projects/<project>/*.jsonl`), subagents, tool results, and project memory;
- relevant file history, session environments, task/todo state, plans, and shell snapshots;
- global Claude agents, skills, commands, hooks, plugins, memory, output styles, settings, and `.claude.json` project/MCP state;
- symlinks, hardlinks, Unicode filenames, and declared filesystem metadata limitations;
- mandatory exclusion of known credential files;
- SHA-256 inventory and manifest integrity checks;
- a self-contained, static `capture-report.html` with no scripts or remote resources;
- detection of source changes and capsule corruption;
- a versioned dry-run restore plan;
- explicit approval before restoring to a new, nonexistent destination;
- remapping of Claude Code’s path-derived project key to the restored repository path;
- isolated Claude-home restoration and activation through `CLAUDE_CONFIG_DIR`;
- post-restore repository, Git, and Claude-state verification with a restore receipt.

Part 1 does **not** capture dedicated credential stores, hidden/provider-side state, external accounts, model internals, or Codex-native task state. It does not yet perform semantic analysis. Locally available Claude Code state is captured as files and restored into a complete isolated Claude configuration directory.

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
  --store /path/to/capsule-store \
  --claude-home /path/to/.claude
```

After reviewing the preview, explicitly confirm capture:

```sh
node scripts/claude-replicant.mjs capture \
  --source /path/to/repository \
  --store /path/to/capsule-store \
  --claude-home /path/to/.claude \
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
  --claude-destination /path/to/new-claude-home \
  --output /path/to/restore-plan.json
```

Execute an approved restore only after reviewing the plan:

```sh
node scripts/claude-replicant.mjs restore \
  --plan /path/to/restore-plan.json \
  --approve \
  --receipt /path/to/restore-receipt.json
```

The restore receipt reports the activation value. Start Claude Code against the isolated restored state with:

```sh
cd /path/to/new-repository
CLAUDE_CONFIG_DIR=/path/to/new-claude-home claude
```

When `--claude-home` is omitted, capture uses `CLAUDE_CONFIG_DIR` and then `~/.claude`. When `--claude-destination` is omitted, planning uses `<new-repository>.claude-home`.

Run `node src/cli.mjs help` for the complete command summary.

## Roadmap

### Part 1 — complete local Claude project capsule (ready)

Capture, integrity validation, corruption refusal, dry-run planning, isolated restore, and post-restore verification for the selected repository plus local Claude Code sessions, memory, agents, and configuration.

### Part 2 — analysis and agent gold standard (later)

1. **Analysis:** derive structured repository observations, project summaries, decisions, work in progress, session evidence, and provenance-linked context without modifying the canonical capsule.
2. **Gold-standard capsules:** establish reviewed Claude Code capsules as canonical training/evaluation material that other agents can learn from or be grounded against, while retaining source provenance and measurable fidelity.
3. **Cross-agent continuity:** let different coding agents continue from the same verified project record without pretending their hidden internal states are interchangeable.

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

The synthetic test fixture covers repository and Claude-state capture, sessions, memory, subagents, skills, agents, static HTML reporting, project-key remapping, isolated Claude-home restoration, validation, corruption refusal, Git verification, credential-store exclusion, live writes, symlinks, hardlinks, ignored files, and Unicode paths.

## Design documentation

See [`docs/TECHNICAL_DESIGN.md`](docs/TECHNICAL_DESIGN.md) for the detailed architecture, threat model, package contracts, safety rules, and phased design.
