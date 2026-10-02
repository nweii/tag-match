# Changelog

Notable changes to Tag Match are documented here using the Keep a Changelog format.

## [Unreleased]

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

[Unreleased]: https://github.com/nweii/tag-match/compare/0.4.0...HEAD
[0.4.0]: https://github.com/nweii/tag-match/compare/0.3.0...0.4.0
