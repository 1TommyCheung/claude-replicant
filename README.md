# Claude Replicant

Claude Replicant Part 1 is a dependency-free Node.js reference implementation for safely migrating a selected Git repository into an immutable capsule store and restoring it to a new destination.

It currently supports a normal, self-contained `.git/` directory. It does not capture credentials, user-global Claude data, agent session state, or semantic analysis.

Requirements:

- macOS
- Node.js `>=22.0.0 <23.0.0`
- Git `>=2.39.0 <3.0.0`

Run `node src/cli.mjs help` for the command workflow. Capture defaults to preview mode and requires `--confirm`. Restore requires a validated plan, a nonexistent destination, and `--approve`.

Run the test suite with `npm test` or the repeatable smoke test with `npm run smoke`.

## Install as a Codex plugin

Add this repository as a marketplace, then install the plugin:

```sh
codex plugin marketplace add 1TommyCheung/claude-replicant --ref main
codex plugin add claude-replicant@claude-replicant
```

Start a new Codex task after installation so the bundled skill is loaded.
