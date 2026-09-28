// Measures three sequential analyses of a synthetic note using the configured provider.
// This makes paid API requests; it sends only the public fixture below and never modifies notes.
// Run: node --experimental-strip-types scripts/benchmark.mjs --config /path/to/data.json
// Timing includes preparation and network requests, but excludes Obsidian UI and tag application.
import { readFile } from 'node:fs/promises';
import { normalizeConfig } from '../src/config.ts';
import { suggest } from '../src/client.ts';
import { fetchTransport } from './cli/cli.ts';
import { resolveCliCredential } from './cli/credentials.ts';

const configPath = process.argv[process.argv.indexOf('--config') + 1];
if (!process.argv.includes('--config') || !configPath) {
  throw new Error('Usage: node --experimental-strip-types scripts/benchmark.mjs --config PATH (makes paid API requests)');
}
const config = await resolveCliCredential(normalizeConfig({ ...JSON.parse(await readFile(configPath, 'utf8')),
  poolMode: 'all', excludedTags: '', guidance: '', definitions: '', maxTagsToAdd: 5, minProbability: 0.75,
}), configPath);
const note = { title: 'Designing accessible signup forms', existingTags: [], body:
  'Accessible signup forms need visible labels, clear instructions, and error messages connected to the relevant fields. Keyboard users should be able to reach every control and see where focus is. Screen readers need meaningful names and notification of validation errors. Avoid asking for unnecessary information. Test the form with people who use assistive technology. A short prototype can reveal confusing field order, weak contrast, and recovery problems before implementation. Document the decisions in the design system so other teams can reuse the pattern.' };
const vocabulary = ['accessibility', 'design', 'forms', 'usability', 'research', 'prototyping', 'design-systems',
  'web', 'development', 'testing', 'documentation', 'typography', 'color', 'interaction-design',
  'product-design', 'keyboard', 'screen-readers', 'validation', 'user-experience', 'privacy',
  'cooking', 'gardening', 'travel', 'finance', 'photography', 'film', 'music', 'fitness',
  'history', 'science', 'mathematics', 'literature', 'languages', 'architecture', 'hardware',
  'networking', 'databases', 'security', 'planning', 'writing'];
const tags = vocabulary.map(tag => ({ tag, count: 1 }));
const runs = [];
for (let index = 0; index < 3; index++) {
  const started = performance.now();
  const result = await suggest(note, tags, config, fetchTransport);
  runs.push({ elapsedMs: Math.round(performance.now() - started), candidates: result.judgments.length,
    batches: result.batches, models: result.models, usage: result.usage,
    recommended: result.recommended.map(item => item.tag) });
}
process.stdout.write(`${JSON.stringify({ date: new Date().toISOString(), provider: config.provider,
  noteCharacters: note.body.length, runs }, null, 2)}\n`);
