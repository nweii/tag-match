# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The README covers user-facing behavior (commands, settings, privacy); `CONTRIBUTING.md` lists the invariants every change must keep. This file covers how the code is put together.

## Commands

- `npm run check` runs lint, tests, build, and a CLI `--help` smoke test. CI and the release workflow run exactly this, so it is the done gate.
- Run one test file or test by name:

  ```bash
  node --experimental-strip-types --loader ./tests/fixtures/obsidian-loader.mjs --test --test-name-pattern="Add only" tests/review.test.ts
  ```

- `npm version <x.y.z>` bumps `package.json` and, through `version-bump.mjs`, `manifest.json` and `versions.json`. A release tag must equal the manifest version.
- `scripts/benchmark*.mjs` make paid API requests against a real provider. Run them only when asked.

## Architecture

One tagging implementation serves two front ends:

- **Shared core** (`src/core.ts`, `client.ts`, `config.ts`, `provider.ts`, `document.ts`) has no Obsidian imports. `core.ts` picks the candidate pool (most-used plus a seeded discovery sample, keyed by `noteSeed` so the same note gets the same sample) and builds batched Jev requests. `client.ts#suggest` sends batches in sequence and fails the whole run if any batch fails, so callers never see partial suggestions.
- **Obsidian plugin** (`src/main.ts`, `review.ts`, `settings.ts`, `vault.ts`, `secret-storage.ts`) adapts the core to Obsidian: tag inventory from the metadata cache, API keys from Obsidian Secrets, writes through `vault.process`.
- **CLI** (`scripts/cli/`) wraps the same core for agents and reads the Secret through the Obsidian CLI or an environment variable (`credentials.ts`).

Invariants that span files:

- **Stale-note protection.** `readNote` captures a snapshot string. `applySuggestions` → `document.ts#addTags` refuses to write if the file no longer matches it, and also rejects tags that left the vocabulary or became excluded. Any new apply path must go through this.
- **Credentials never persist.** `Config` holds keys at runtime, but `persistedConfig` strips them before `saveData`. `data.json` stores only Secret IDs. Call `hydrateCredentials` right before each network run so a changed Secret is used.
- **One run per note.** `plugin.beginRun`/`endRun` guard concurrent analyses of a file. Closing the review modal aborts its controller.
- **CLI identity check.** `build.mjs` bundles the CLI twice: once with a fixed version to hash its content, then for real. The plugin embeds that hash (`__TAG_MATCH_CLI_IDENTITY__`) and compares it with the installed `tag-match.mjs` header to decide whether to offer a CLI update. Plugin-only version bumps therefore do not trigger an update prompt.
- The review modal copies `plugin.settings` when it opens, so its preview and its analysis use one settings snapshot even if settings change in between.

## Testing UI code

Tests run TypeScript directly under Node, with no DOM. `tests/fixtures/obsidian-loader.mjs` redirects `import 'obsidian'` to `obsidian-runtime.mjs`, a small stub of `Modal`, `Setting`, `ButtonComponent`, and a `TestElement` tree. UI tests find controls by walking that tree (`all('button')`, `textContent`, `placeholder`). When you use an Obsidian API or DOM method the stub lacks, extend the stub. Rendered layout and CSS are never tested, so check visual changes in Obsidian itself.

## Conventions

- ESLint runs `eslint-plugin-obsidianmd` with a sentence-case rule for UI strings. Add new brand names or acronyms to its allowlist in `eslint.config.mts` rather than working around the rule.
- `stylelint.config.mjs` mirrors the CSS checks Obsidian runs on published plugins: no `!important` and no `:has`. Hide elements with the `hidden` attribute (the review's `[hidden]` rule outranks its `display` rules), and mark special-case setting rows with a class set in code.
- Style with Obsidian CSS variables (`--size-4-*`, `--text-*`, `--background-modifier-*`) in `styles.css`, prefixed `tag-match-`. Build UI with `Setting` rows and native elements so themes and mobile work.
- `main.js` and `dist/` are build outputs and are gitignored. `docs/agent-cli.md` ships to users as `AGENT-CLI.md`, so treat it as user-facing documentation.
