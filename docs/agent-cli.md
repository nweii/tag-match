# Tag Match agent CLI

This guide is installed beside `tag-match.mjs` and `data.json`. Resolve those sibling paths from this file instead of guessing a plugin or vault location. Tag Match uses the saved provider, model, tagging settings, and matching Obsidian Secret reference. TypeSafe and OpenRouter credentials stay separate.

The CLI requires Node.js 22 or later. Run the sibling CLI with `--help` first. Its help is the source of truth for command syntax, JSON input and output, network access, and file-writing behavior. Pass the sibling `data.json` as the configuration path. Network commands read the selected Obsidian Secret through the official `obsidian` command, which requires the desktop app to be running with that vault open. For standalone use, set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` for the selected provider. Offline `help`, `preview`, and `apply` commands do not request a credential.

A synced `data.json` can contain a Secret name without its key on this device. For network commands, the user can add the key in Obsidian Secrets here or supply the selected provider's environment variable.

Use `review` by default for tagging. Confirm that it returned `review-ready`, inspect the proposed tags, then use `apply` with only the tags the user approved. The task is complete when apply reports `applied` or `no-op` and its path and added tags match the request. Review does not write, and apply makes no network request.

`poolMode: "specific"` uses `onlyTags`, a comma- or newline-separated explicit tag set. Every listed tag is considered, including tags absent from the inventory; pool size, sampling, minimum-use settings, and `excludedTags` do not apply. An empty set scores no tags and never falls back to the vault inventory. Other modes use inventory selection and `excludedTags`. Tags already on the note are skipped in every mode. Minimum match score and maximum additions apply in every mode. These fields are shared with the plugin defaults.

For one invocation, use `--only-tags 'research, writing'`, `--exclude-tags 'admin, work/*'`, `--min-score 0.8`, or `--max-tags 3`. JSON input may include an `overrides` object with tagging settings (selection mode, size, mix, minimum uses, matching thresholds, context limit, guidance, definitions, and provider/model). Flags take precedence over JSON overrides, which take precedence over the saved configuration. Overrides never rewrite `data.json`. They apply to `preview`, `suggest`, `review`, `apply`, `quick-apply`, and `bulk`. For `apply`, provide the same specific set used for review; application checks it against the current invocation's allowed tags. Credentials belong in the environment or saved configuration, never in overrides. Tag names accept optional `#` prefixes. The vocabulary `tags` array may be omitted when using a specific set.

For default (`auto`), percentage, and number modes, `mostUsedPercent` sets the share selected by use count from 0 to 100. The remaining places sample other tags, including rarely used tags. The default is 70. `preview` returns each included tag's internal reason and an inspection list that distinguishes included, excluded, already-present, and outside-selection tags. The same note, inventory, and settings produce the same selection.

Use `quick-apply` only when the user explicitly authorizes writing recommendations without review. Confirm its final status, path, and added tags. Failed, partial, cancelled, or stale analysis must not count as completion.

## Bulk tagging

`bulk` reads a JSON selection from stdin. Select individual notes, folders, or both. Folders include their Markdown descendants; canonical paths are deduplicated. `excludeNotes` removes individual notes from folder selections. Each note can provide its own inline `existingTags`; the CLI reads frontmatter tags itself. Supply the vault tag inventory once for the batch, or use `--only-tags` without an inventory.

```json
{
  "notes": [
    "/absolute/vault/one.md",
    { "path": "/absolute/vault/two.md", "existingTags": ["inline-tag"] }
  ],
  "folders": ["/absolute/vault/Projects"],
  "excludeNotes": ["/absolute/vault/Projects/skip.md"],
  "tags": [{ "tag": "design", "count": 12 }],
  "overrides": { "minProbability": 0.8, "maxTagsToAdd": 3 }
}
```

The default is an offline dry run: it reads selected notes and reports candidate tags, request estimates, and preparation errors, without resolving credentials, contacting a provider, or writing notes. `--sort modified` defaults to newest first; `created` and `alphabetical` are also supported. `--reverse` reverses the ordering. `--search TEXT` filters the selected batch by title or folder, together with `excludeNotes`; it does not expand the selection.

```sh
cat batch.json | tag-match bulk --config /absolute/vault/.obsidian/plugins/tag-match/data.json --dry-run
cat batch.json | tag-match bulk --config /absolute/vault/.obsidian/plugins/tag-match/data.json --only-tags 'research, writing' --suggest
cat batch.json | tag-match bulk --config /absolute/vault/.obsidian/plugins/tag-match/data.json --apply --recovery /absolute/path/batch-undo.jsonl
```

`--suggest` uses API credits and returns a review plan for each successfully analyzed note without writing it. Inspect each plan and use `apply` with the approved tags. `--apply` writes recommendations directly and requires explicit user authorization for that batch. Use a fresh `--recovery` path; existing files are never overwritten. The recovery file contains original note text, has owner-only permissions, and is flushed before each corresponding note write. It supports undo after the process exits. The same recovery capacity limit applies as in Obsidian (about 64 MiB of original and written text).

Up to three notes run in parallel, with one settings and vocabulary snapshot for the batch. Use `--concurrency 1`, `2`, or `3` to set the limit. Notes have separate context and results. Stale notes are skipped, note-specific errors are isolated, and provider-wide failures stop pending and in-flight work. Ctrl-C or SIGTERM cancels unfinished work; completed additions remain recorded for undo. An in-flight provider request can still consume credits. Run the CLI as a shell job if it needs to continue while you do other work; progress and results can be redirected to files.

Stdout is one JSON report with outcomes, counts, effective settings, and the recovery path when applying. Reports exclude note bodies and credentials. Progress uses JSON lines on stderr; `--quiet` suppresses it. `--filter failed` (or another status listed in `--help`) narrows the returned results, while totals and summary still cover the entire batch. Exit code `0` means complete, `1` means an error or partial batch including skipped notes, and `130` means cancelled. Always inspect the report, including after a nonzero exit; do not rerun already applied notes as if the whole batch failed.

## Bulk undo

Undo needs no credentials, configuration, stdin, or network access. It defaults to an offline preview. Use `--apply` only when the user authorizes undo. Notes whose content changed after tagging are skipped to preserve those edits. Repeating undo is safe; notes already restored are unchanged. Retain the recovery file until undo is no longer needed.

```sh
tag-match bulk-undo --recovery /absolute/path/batch-undo.jsonl
tag-match bulk-undo --recovery /absolute/path/batch-undo.jsonl --apply
```

From the target vault directory, `obsidian tags counts format=json` returns vocabulary as an array like `[{"tag":"#example","count":"2"}]`. Tag Match accepts those numeric count strings. To get a note's current tags, run `obsidian tags path='folder/note.md' format=json` from the absolute vault directory, using the note's vault-relative path. It returns records like `[{"tag":"#example"}]`; pass `rows.map(item => item.tag)` as `existingTags`. Tag Match's `--note` argument remains the absolute Markdown path. The Obsidian commands require the app to be running and use the current working directory to choose the vault. The Tag Match CLI itself can run without Obsidian when the caller supplies the inventory and existing tags. It reads frontmatter tags itself and deliberately does not guess inline tags from Markdown text.

The CLI prints one JSON result to stdout. Errors go to stderr with a nonzero exit code. It does not put credentials in command arguments or print them. Never print the API key or the contents of `data.json`.
