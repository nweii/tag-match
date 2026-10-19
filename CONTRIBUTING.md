# Contributing

For substantial changes, open an issue first to discuss the intended behavior and scope. Keep changes focused and preserve the review-first workflow, stale-note checks, credential isolation, mobile compatibility, and use of Obsidian's public APIs.

Use Node.js 22 or later, then run:

```sh
npm ci
npm run check
```

Pull requests should explain the user-visible behavior, network or privacy effects, and relevant validation. Never commit API keys, private notes, vault data, or generated `data.json` files.

## Development builds

Prepare changes on a development branch and set the target release version with `npm version x.y.z --no-git-tag-version`. `npm run build:dev` produces Tag Match Dev with that version and a source build identifier, separate from the public release artifacts.

Install into a dedicated test vault:

```sh
npm run dev:install -- --vault "/absolute/path/to/test-vault"
```

The installer updates `tag-match-dev`, its CLI, and its agent guide together while preserving settings. Use `--config-dir` for a vault with an alternate configuration folder. Reload Tag Match Dev in Obsidian after installing, then verify its version, build identifier, and CLI status. Keep one Tag Match variant enabled at a time when testing both in the same vault.

Development builds retain up to 120 capture and apply diagnostic events in device-local Obsidian storage, outside the synced vault. Use **Tag Match Dev: Copy local diagnostics** to copy the history. Events contain build and timing data, random correlation IDs, sizes, and changed-field flags. They contain no note text, filenames, tag values, credentials, or raw error messages. Release builds exclude this logging and command.

`npm run build` creates the public release artifacts. See `AGENTS.md` for installation boundaries and release checks.
