# Changelog

Notable changes to Tag Match are documented here using the Keep a Changelog format.

## [Unreleased]

## [0.4.2] - 2026-10-18

### Added

- Development builds retain a bounded diagnostic history on the current device, with a command to copy it. Diagnostics report timing and changed fields without note text, filenames, tag values, or credentials.

### Changed

- The default OpenRouter model is `~typesafe/jev-latest`, which follows the latest Jev model. Existing saved model selections are preserved.

### Fixed

- Automatic timestamps and frontmatter formatting could trigger a false note-change warning after analysis. Applying tags preserves unrelated metadata changes while rejecting changes to the analyzed body, description, or tags.
- Notes without frontmatter and with a leading byte order mark could trigger a false note-change warning. Tagging preserves the marker and continues to reject intervening content edits.
- Bulk undo retains the exact document from immediately before tags were added, including metadata updated during analysis. Recovery limits are checked before writing.

## [0.4.1] - 2026-10-08

### Added

- OpenAI’s Decisions API as a provider option for single-note and bulk tagging, with GPT-6 Luna as its default model.
- A TypeSafe model field and links to compatible model IDs for every provider.

### Fixed

- Clef requests could exceed its 64-question limit and fail before returning matches. Candidate tags are now split into compatible batches.
- Recognized provider question-count limit errors now trigger smaller batches with bounded retries, preserving all candidate tags.

## [0.4.0] - 2026-10-02

### Added

- CLI bulk tagging for selected notes, folders, or a mix of both, with recursive folder selection, note exclusions, search, and sorting.
- Bulk dry runs showing selected notes, candidate tags, and estimated provider requests without API calls or note changes. Separate modes use Jev to return suggestions or apply matches, with up to three notes analyzed in parallel.
- Bulk progress, per-note outcomes, result filters, cancellation, and durable undo through a recovery file. Undo preserves notes edited after tagging.
- Added the option to provide a specific tag list for one note or a batch, including tags not yet in the vault, instead of using existing vault tags.
- Per-run CLI tag selection and matching overrides across single-note and bulk commands. Overrides leave saved settings unchanged.

### Changed

- Renamed the single-note suggestion command to “Suggest tags for current note…” and the instant-apply action to “Match and add tags to current note.” Dialog headings follow the commands.
- Moved “Copy results” beside the results filter above the bulk results list.
- Tag-entry examples omit optional `#` prefixes.

### Fixed

- Tagging dialogs previously jumped in height as content changed. They now keep a stable height and scroll longer content.
- Note titles were clipped at the top of the single-note suggestion dialog. They now display fully, including wrapped lines.

[Unreleased]: https://github.com/nweii/tag-match/compare/0.4.2...HEAD
[0.4.2]: https://github.com/nweii/tag-match/compare/0.4.1...0.4.2
[0.4.1]: https://github.com/nweii/tag-match/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/nweii/tag-match/compare/0.3.0...0.4.0
