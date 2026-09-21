# Tag Match

Quickly find the right tags from your vault.

Tag Match finds relevant tags from the vocabulary you already use. A decision model scores each candidate against the note and the meanings, conventions, and preferences you provide. Review the matches or apply the strongest ones directly.

Tag Match supports **Jev through TypeSafe or OpenRouter**. It requires a TypeSafe or OpenRouter account and API key. Tag analysis uses paid API credits.

## Features

- **Tags that fit your system.** Match notes by meaning, using your tag definitions and conventions to guide recommendations beyond keyword matches.
- **Fast, low-cost matching.** A measured 40-tag example took 202–660 ms at an estimated $0.00024 per run. [Benchmark fixture and runner](scripts/benchmark.mjs).
- **Control over what gets added.** Choose which tags to consider, exclude tags or branches, and set a score threshold and addition limit. Review the matches or apply them directly.
- **Fits your agent workflows.** Let your agents tag notes with the same preferences and API connection you use in Obsidian. The optional CLI supports review, direct application, and other decision tasks.

## Getting started

Tag Match requires Obsidian 1.13.0 or later.

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nweii/tag-match/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/tag-match/`, then reload Obsidian and enable Tag Match under **Settings → Community plugins**.
3. Open Tag Match settings, choose TypeSafe or OpenRouter, and select an Obsidian Secret containing its API key.
4. Open a Markdown note and run **Tag Match: Review tags for current note**. Select **Analyze note**, review the checked matches, then select **Add selected tags**.

For direct application, run **Tag Match: Add recommended tags to current note**. It sends the note for analysis and adds the recommendations without a review dialog. Both commands respect your exclusions and maximum additions, preserve existing tags, and refuse to apply an analysis if the note has changed.

The plugin uses Obsidian APIs available on desktop and mobile. The companion CLI requires a computer with Node.js 22 or later.

## Tune the suggestions

Automatic coverage checks every eligible tag when there are 100 or fewer. For larger vocabularies, it checks the most-used 100 tags or the top 20%, whichever is larger. Excluded tags and tags already on the note are removed first.

The defaults preselect up to five tags with a score of at least 75%. These are two separate controls: **coverage** determines which tags the model sees; **maximum tags to add** limits what goes onto the note. A higher score threshold produces fewer recommendations. A tag outside the candidate pool cannot be recommended.

Use short rules for general guidance, such as “Tag substantial topics; skip passing mentions.” Give individual tags a definition when your use differs from their ordinary meaning:

```text
dev = Building, debugging, or maintaining software; include implementation tutorials; exclude general technology news without development content.
```

Use **Excluded tags** for firm exclusions: `admin` excludes that tag; `work/*` excludes `work` and its descendants. Natural-language guidance influences the model's judgment; exclusions and addition limits are enforced by the plugin.

Long notes are sampled from the beginning, middle, and end within your text limit. The review shows candidate coverage and whether the note was sampled before you start analysis.

## Agents and scripts

The optional companion uses the same saved provider, Obsidian Secret, coverage, definitions, exclusions, and limits as the plugin. It is a portable Node CLI; it does not register itself automatically with agent applications.

On desktop, choose **Copy install command** in Tag Match settings and paste it into your terminal. The command fetches and runs `install-cli.mjs` from the GitHub release matching your installed plugin version. The installer places the CLI and guide beside the plugin and does not copy credentials. Reload Tag Match afterward. After a plugin update, use **Copy update command** to refresh the companion.

You can also extract `tag-match-agent.zip` from the [matching release](https://github.com/nweii/tag-match/releases) into the plugin folder. Obsidian’s standard plugin installer does not install these optional files.

Then use **Copy agent instruction** in Tag Match settings. The short instruction directs an agent to the installed guide; `--help` documents the command inputs and outputs. See the [agent guide](docs/agent-cli.md) for review and direct-apply workflows, and for obtaining the vault's tag inventory.

An agent can compose `preview`, `suggest`, `review`, and `apply`, or use `quick-apply` when direct application is wanted. `evaluate` exposes general decision questions. The CLI can run without Obsidian when the caller supplies the tag inventory and existing tags.

## Speed and cost

In a small synthetic benchmark on September 21, 2026, scoring **40 candidate tags in one batch** took **202–660 ms across three runs** (216 ms median). At TypeSafe's published Jev 1.13 rate, the reported input usage works out to approximately **$0.00024 per run**. This is a narrow measurement, not a latency or price guarantee: longer notes, more candidates, retries, and network conditions change the total. See the [benchmark runner](scripts/benchmark.mjs) and [recorded measurements](scripts/benchmark-baseline.json).

Check [TypeSafe's current pricing](https://docs.typesafe.ai/models) or [OpenRouter's model page](https://openrouter.ai/typesafe/jev-1.13) before use. Model scores are judgments, not guarantees; review results while tuning your conventions.

## Privacy and network access

Analysis sends the note title, description, existing tags, selected body text, candidate tags, tagging guidance, and relevant tag definitions to your chosen service: `api.typesafe.ai` or `openrouter.ai`. With OpenRouter, requests are routed to the model provider. Analysis starts only when you invoke it; there is no background vault scan sent to a model.

API keys are stored through Obsidian Secrets in local, vault-scoped storage. The plugin's `data.json` stores only each selected secret's reference. Tag Match has no client-side telemetry. Provider data handling follows [TypeSafe's privacy policy](https://typesafe.ai/legal/privacy-policy) and, when selected, [OpenRouter's privacy policy](https://openrouter.ai/privacy).

The Obsidian plugin operates within your vault. The optional CLI reads its explicit configuration path and can read or modify a Markdown file outside a vault when you supply that path. It does not search your filesystem for notes or credentials.

## Development and support

See [Contributing](CONTRIBUTING.md) for setup and checks, or [report a bug](https://github.com/nweii/tag-match/issues/new/choose). For a security concern, follow [the security policy](SECURITY.md).

Tag Match is an independent project by Nathan Cheng and is not affiliated with Obsidian, TypeSafe, or OpenRouter.

[Buy me a coffee](https://buymeacoffee.com/nthnwei).

See [LICENSE](LICENSE) for the source license and [third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependencies.
