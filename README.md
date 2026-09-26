# Tag Match

Tag Match finds relevant tags among those in your Obsidian vault for a given note. It uses an AI decision model to judge each candidate against your note, optionally using tagging rules and definitions you provide. You can review its suggestions or add top matches directly.

## AI models

Tag Match uses Jev through TypeSafe or OpenRouter. Analysis requires an account, an API key, and paid API credits with either provider.

## Features

- **Matches your tag system.** Shape which tags fit a note using natural-language definitions and rules.
- **Fast, low-cost analysis.** In a synthetic short-note test, Jev evaluated 800 tags in about 2.1 seconds at an estimated cost of less than half a cent. See [speed and cost](#speed-and-cost) for the measurement and its limits.
- **Fine-grained controls.** Set how many tags to consider, exclude tags or branches, and choose a minimum match score and addition limit. Review suggestions or apply them directly.
- **Fits existing agent workflows.** Your AI agents can tag notes with the same preferences and provider connections you use in Obsidian. The optional CLI supports review, direct application, and other decision tasks.

## Getting started

You need Obsidian 1.13.0 or later and a TypeSafe or OpenRouter API key.

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/nweii/tag-match/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/tag-match/`, then reload Obsidian and enable Tag Match under **Settings → Community plugins**.
3. Open Tag Match settings, choose TypeSafe or OpenRouter, and select an Obsidian Secret containing its API key.
4. Open a Markdown note and run **Tag Match: Review tags for current note**. Select **Analyze note**, review the checked matches, then select **Add selected tags**.

For direct application, run **Tag Match: Add recommended tags to current note**. It analyzes the note and adds recommendations without a review dialog. Both commands respect your exclusions and maximum additions, and refuse to apply an analysis if the note has changed.

The plugin uses Obsidian APIs available on desktop and mobile. The companion CLI requires a computer with Node.js 22 or later.

## How Tag Match chooses tags

### Tags to consider

By default, Tag Match considers all tags in a small vault. With more than 250 tags, it considers 250 tags or 20% of the available tags, whichever is larger. You can choose a specific number or percentage instead, or choose **All tags** to consider every tag.

When the selection is limited, 70% comes from your most-used tags and 30% is sampled from other tags, including rarely used ones. You can adjust that mix. The sample varies between notes, giving less-used tags a chance without checking your entire vocabulary every time.

### Suggestions and tagging context

Tag Match preselects up to five tags with a match score of at least 75%. **Tags to consider** controls what the model sees; **Maximum tags to add** controls how many recommendations can go onto a note. Raise the minimum score for fewer recommendations.

Use short rules for general guidance, such as “Tag substantial topics; skip passing mentions.” Give individual tags a definition when your use differs from their ordinary meaning:

```text
dev = Building, debugging, or maintaining software; include implementation tutorials; exclude general technology news without development content.
```

Use **Excluded tags** for firm exclusions: `admin` excludes that tag; `work/*` excludes `work` and its descendants. Guidance influences the model's judgment; exclusions and addition limits are enforced by the plugin.

Long notes are sampled from the beginning, middle, and end within your text limit. The review shows how many tags will be considered and whether the note was sampled before analysis.

## Agents and scripts

Agents can use Tag Match through a companion Node CLI. It shares the plugin's saved provider, model, tagging preferences, and Obsidian Secret reference. The CLI reads the Secret while that vault is open in Obsidian; an environment variable can supply the key when Obsidian is closed.

On desktop, choose **Copy install command** in Tag Match settings and paste it into your terminal. The command fetches `install-cli.mjs` from the GitHub release matching your plugin version. The installer places the CLI and guide beside the plugin and does not copy credentials. Reload Tag Match afterward. After a plugin update, use **Copy CLI update command** to refresh the companion.

You can also extract `tag-match-agent.zip` from the [matching release](https://github.com/nweii/tag-match/releases) into the plugin folder. Obsidian’s standard plugin installer does not install these optional files.

Use **Copy agent instruction** in Tag Match settings to point an agent to the installed guide. The CLI's `--help` documents its commands and inputs. See the [agent guide](./docs/agent-cli.md) for review and direct-apply workflows, and for obtaining the vault's tag inventory.

An agent can combine `preview`, `suggest`, `review`, and `apply`, or use `quick-apply` for direct application. `evaluate` exposes general decision questions. The CLI can run without Obsidian when the caller supplies the tag inventory and existing tags.

## Speed and cost

In a synthetic short-note benchmark, Jev evaluated **800 candidate tags in 2.09–2.14 seconds** across two runs with the plugin's normal batch size. Reported usage works out to about **$0.0047 per run** at TypeSafe's published Jev 1.13 input rate at the time of measurement. Timing includes preparation and network requests, but excludes the Obsidian interface and note writes. Longer notes, tag definitions, retries, and network conditions can change both time and cost. See the [benchmark runner](./scripts/benchmark-batching.mjs) and [recorded measurements](./scripts/benchmark-batching-baseline.json).

Check [TypeSafe's current pricing](https://docs.typesafe.ai/models) or [OpenRouter's model page](https://openrouter.ai/typesafe/jev-1.13) before use.

## Privacy and network access

Analysis sends the note title, description, existing tags, selected body text, candidate tags, tagging guidance, and relevant tag definitions to your chosen service: `api.typesafe.ai` or `openrouter.ai`. With OpenRouter, requests are routed to the model provider. Analysis starts only when you invoke it; there is no background vault scan sent to a model.

API keys are stored through Obsidian Secrets in local, vault-scoped storage. The plugin's `data.json` stores only each selected secret's reference. Tag Match has no client-side telemetry. Provider data handling follows [TypeSafe's privacy policy](https://typesafe.ai/legal/privacy-policy) and, when selected, [OpenRouter's privacy policy](https://openrouter.ai/privacy).

The Obsidian plugin operates within your vault. The optional CLI reads its explicit configuration path and can read or modify a Markdown file outside a vault when you supply that path. It does not search your filesystem for notes or credentials.

## Development and support

See [Contributing](./CONTRIBUTING.md) for setup and checks, or [report a bug](https://github.com/nweii/tag-match/issues/new/choose). For a security concern, follow [the security policy](./SECURITY.md).

Tag Match is an independent project by [Nathan Cheng](https://nathancheng.work/) and is not affiliated with Obsidian, TypeSafe, or OpenRouter.

[Buy me a coffee](https://buymeacoffee.com/nthnwei).

See [LICENSE](./LICENSE) for the source license and [third-party notices](./THIRD_PARTY_NOTICES.md) for bundled dependencies.
