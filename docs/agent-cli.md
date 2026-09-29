# Tag Match agent CLI

This guide is installed beside `tag-match.mjs` and `data.json`. Resolve those sibling paths from this file instead of guessing a plugin or vault location. Tag Match uses the saved provider, model, tagging settings, and matching Obsidian Secret reference. TypeSafe and OpenRouter credentials stay separate.

The CLI requires Node.js 22 or later. Run the sibling CLI with `--help` first. Its help is the source of truth for command syntax, JSON input and output, network access, and file-writing behavior. Pass the sibling `data.json` as the configuration path. Network commands read the selected Obsidian Secret through the official `obsidian` command, which requires the desktop app to be running with that vault open. For standalone use, set `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` for the selected provider. Offline `help`, `preview`, and `apply` commands do not request a credential.

A synced `data.json` can contain a Secret name without its key on this device. For network commands, the user can add the key in Obsidian Secrets here or supply the selected provider's environment variable.

Use `review` by default for tagging. Confirm that it returned `review-ready`, inspect the proposed tags, then use `apply` with only the tags the user approved. The task is complete when apply reports `applied` or `no-op` and its path and added tags match the request. Review does not write, and apply makes no network request.

For default (`auto`), percentage, and number modes, `mostUsedPercent` sets the share selected by use count from 0 to 100. The remaining places sample other tags, including rarely used tags. The default is 70. `preview` returns each included tag's internal reason and an inspection list that distinguishes included, excluded, already-present, and outside-selection tags. The same note, inventory, and settings produce the same selection.

Use `quick-apply` only when the user explicitly authorizes writing recommendations without review. Confirm its final status, path, and added tags. Failed, partial, cancelled, or stale analysis must not count as completion.

From the target vault directory, `obsidian tags counts format=json` returns vocabulary as an array like `[{"tag":"#example","count":"2"}]`. Tag Match accepts those numeric count strings. To get a note's current tags, run `obsidian tags path='folder/note.md' format=json` from the absolute vault directory, using the note's vault-relative path. It returns records like `[{"tag":"#example"}]`; pass `rows.map(item => item.tag)` as `existingTags`. Tag Match's `--note` argument remains the absolute Markdown path. The Obsidian commands require the app to be running and use the current working directory to choose the vault. The Tag Match CLI itself can run without Obsidian when the caller supplies the inventory and existing tags. It reads frontmatter tags itself and deliberately does not guess inline tags from Markdown text.

The CLI prints one JSON result to stdout. Errors go to stderr with a nonzero exit code. It does not put credentials in command arguments or print them. Never print the API key or the contents of `data.json`.
