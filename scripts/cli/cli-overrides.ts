// Validates per-invocation tagging settings without changing saved defaults or accepting credentials on stdin.
import { normalizeConfig, record, type Config } from '../../src/config.ts';

const ranges = { poolPercent: [1, 100], poolCount: [1, 1000000], minimumUses: [1, 1000000], mostUsedPercent: [0, 100],
  maxTagsToAdd: [1, 1000], minProbability: [0, 1], maxBodyChars: [200, 24000] } as const;
const textKeys = ['onlyTags', 'excludedTags', 'guidance', 'definitions', 'model', 'openRouterModel'] as const;

export function withOverrides(config: Config, value: unknown): Config {
  if (value === undefined) return { ...config };
  if (!record(value)) throw new Error('overrides must be an object of tagging settings.');
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'poolMode') {
      if (!['auto', 'all', 'percent', 'count', 'minimum', 'specific'].includes(String(setting))) throw new Error('Invalid poolMode override.');
    } else if (key === 'provider') {
      if (setting !== 'typesafe' && setting !== 'openrouter') throw new Error('Invalid provider override.');
    } else if (textKeys.includes(key as typeof textKeys[number])) {
      if (typeof setting !== 'string') throw new Error(`${key} must be text.`);
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key as keyof typeof ranges];
      if (typeof setting !== 'number' || !Number.isFinite(setting) || setting < min || setting > max
        || (key !== 'minProbability' && !Number.isInteger(setting))) throw new Error(`${key} must be ${key === 'minProbability' ? 'a number' : 'a whole number'} from ${min} to ${max}.`);
    } else throw new Error(`Unknown override: ${key}. Credentials must come from the saved config or environment.`);
  }
  return normalizeConfig({ ...config, ...value });
}
