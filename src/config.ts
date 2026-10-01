// Defines the shared settings used by Obsidian and the CLI, including validation.
export interface Config {
  provider: 'typesafe' | 'openrouter';
  typeSafeSecretId: string;
  apiKey: string;
  model: string;
  openRouterApiKey: string;
  openRouterSecretId: string;
  openRouterModel: string;
  poolMode: 'auto' | 'percent' | 'count' | 'minimum' | 'all' | 'specific';
  poolPercent: number;
  poolCount: number;
  minimumUses: number;
  mostUsedPercent: number;
  maxTagsToAdd: number;
  minProbability: number;
  maxBodyChars: number;
  onlyTags: string;
  excludedTags: string;
  guidance: string;
  definitions: string;
}

export const DEFAULTS: Config = {
  provider: 'typesafe', typeSafeSecretId: '', apiKey: '', model: 'jev-latest', openRouterApiKey: '',
  openRouterSecretId: '', openRouterModel: 'typesafe/jev-1.13',
  poolMode: 'auto', poolPercent: 20,
  poolCount: 100, minimumUses: 2, mostUsedPercent: 70,
  maxTagsToAdd: 5, minProbability: 0.75, maxBodyChars: 16000,
  onlyTags: '', excludedTags: '', guidance: '', definitions: '',
};

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeConfig(value: unknown): Config {
  const raw = record(value) ? value : {};
  const result = { ...DEFAULTS };
  for (const key of ['typeSafeSecretId', 'apiKey', 'model', 'openRouterApiKey', 'openRouterSecretId', 'openRouterModel', 'onlyTags', 'excludedTags', 'guidance', 'definitions'] as const) {
    if (typeof raw[key] === 'string') result[key] = raw[key];
  }
  result.apiKey = result.apiKey.trim();
  result.typeSafeSecretId = result.typeSafeSecretId.trim();
  result.model = result.model.trim() || DEFAULTS.model;
  result.openRouterApiKey = result.openRouterApiKey.trim();
  result.openRouterSecretId = result.openRouterSecretId.trim();
  result.openRouterModel = result.openRouterModel.trim() || DEFAULTS.openRouterModel;
  if (raw.provider === 'typesafe' || raw.provider === 'openrouter') result.provider = raw.provider;
  if (raw.poolMode === 'auto' || raw.poolMode === 'percent' || raw.poolMode === 'count' || raw.poolMode === 'minimum' || raw.poolMode === 'all' || raw.poolMode === 'specific') {
    result.poolMode = raw.poolMode;
  }
  const limits = {
    poolPercent: [1, 100], poolCount: [1, 1000000], minimumUses: [1, 1000000], mostUsedPercent: [0, 100],
    maxTagsToAdd: [1, 1000],
    minProbability: [0, 1], maxBodyChars: [200, 24000],
  } as const;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) continue;
    const [min, max] = limits[key];
    result[key] = Math.min(max, Math.max(min, key === 'minProbability' ? number : Math.round(number)));
  }
  return result;
}

export type PersistedConfig = Omit<Config, 'apiKey' | 'openRouterApiKey'>
  & Partial<Pick<Config, 'apiKey' | 'openRouterApiKey'>>;

export function persistedConfig(config: Config): PersistedConfig {
  const normalized = normalizeConfig(config);
  const { apiKey, openRouterApiKey, ...saved } = normalized;
  return {
    ...saved,
    ...(!normalized.typeSafeSecretId && apiKey ? { apiKey } : {}),
    ...(!normalized.openRouterSecretId && openRouterApiKey ? { openRouterApiKey } : {}),
  };
}
