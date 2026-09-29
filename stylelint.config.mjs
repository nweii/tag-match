// Flags the CSS patterns Obsidian's community plugin checks warn about, so they fail locally before a release.
export default {
  rules: {
    // Obsidian asks plugins to override styles through selector specificity or CSS variables instead.
    'declaration-no-important': true,
    // Obsidian warns that :has can cause broad selector invalidation and slow the app.
    'selector-pseudo-class-disallowed-list': ['has'],
  },
};
