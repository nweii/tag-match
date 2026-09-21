# Contributing

For substantial changes, open an issue first to discuss the intended behavior and scope. Keep changes focused and preserve the review-first workflow, stale-note checks, credential isolation, mobile compatibility, and use of Obsidian's public APIs.

Use Node.js 22 or later, then run:

```sh
npm ci
npm run check
```

Pull requests should explain the user-visible behavior, network or privacy effects, and relevant validation. Never commit API keys, private notes, vault data, or generated `data.json` files.
