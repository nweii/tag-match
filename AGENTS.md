# Development and releases

Read `CLAUDE.md` for architecture, invariants, and checks; read `CONTRIBUTING.md` before preparing a contribution.

## Version and build identity

Start release preparation on a development branch. Set the intended release version with `npm version x.y.z --no-git-tag-version` before building or testing; keep package, lockfile, manifest, and compatibility map aligned. Preserve each file's formatting when bumping versions. The published branch keeps its released version until the release is prepared.

The manifest version identifies the target release. Development builds additionally show the source commit and `+` for uncommitted changes. Preserve this distinction in both the plugin and CLI.

## Local development

- `npm run build:dev` builds **Tag Match Dev** (`tag-match-dev`) and its companion CLI into `dist/tag-match-dev/`.
- `npm run dev:install -- --vault "/absolute/path/to/test-vault"` builds and installs the development plugin, CLI, and guide together. Reload the development plugin afterward.
- Use a dedicated test vault with synthetic notes for routine QA and write/undo tests. Brain can host the development plugin for testing the actual vault interface; keep one Tag Match variant enabled at a time there.
- Preserve the stable `tag-match` installation, existing `data.json`, Obsidian Secrets, and vault configuration. The development installer owns only the generated files inside `tag-match-dev`.
- Development settings are independent. Development companion updates come from the local installer rather than GitHub release downloads.
- Use development-specific provider Secrets in the test vault. Preserve their selected references across installs; routine QA uses mocked responses, and real provider requests require Nathan's explicit request.

After installing, verify the loaded plugin ID, target version, build identifier, and companion status in Obsidian. Check rendered settings and dialogs in the app for visual changes. A successful build or copied files alone do not prove activation.

## Release preparation

Run `npm run check`. The default `npm run build` produces the public `tag-match` artifacts and companion bundle; development builds leave those outputs untouched.

Verify that release assets use the public plugin ID/name and contain no development stamp. Follow the GitHub release workflow and publish only with Nathan's authorization. Verify published assets and release state before reporting completion. Keep the installed stable plugin on verified published assets.

Prepare the version bump on a release branch. Push its matching version tag to build an attested draft, verify its assets, and obtain publication authorization. Publish the complete release **before merging the manifest version bump into main**. Obsidian reads the public manifest before downloading assets from the matching release tag; a version advertised without its release can fail installation or disappear from distribution.

The required **Release publication** check rejects a version change unless the exact public stable release serves `main.js`, `manifest.json`, and `styles.css` byte-for-byte as built from the candidate branch. Draft releases do not satisfy the check. Run `npm run check:release -- <base commit SHA>` to exercise it locally. An unchanged version requires no publication or network check.

After publication, use the Community author dashboard's **Check for new releases** and confirm the matching review completed. Verify the public listing and desktop update separately; the desktop catalog uses a mirrored index and can lag the website. Do not report a normal Community update as verified from manual file copies or a direct installer call alone.
