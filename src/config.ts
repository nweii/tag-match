// Defines the shared settings used by Obsidian and the CLI, including validation.
import { PROVIDERS } from './provider.ts';

export const PROVIDER_NAMES = ['typesafe', 'openrouter', 'openai', 'gemini'] as const;

export interface Config {
  provider: typeof PROVIDER_NAMES[number];
  typeSafeSecretId: string;
  apiKey: string;
  model: string;
  openRouterApiKey: string;
  openRouterSecretId: string;
  openRouterModel: string;
  openAiApiKey: string;
  openAiSecretId: string;
  openAiModel: string;
  geminiApiKey: string;
  geminiSecretId: string;
  geminiModel: string;
  poolMode: 'auto' | 'percent' | 'count' | 'minimum' | 'all' | 'specific';
  poolPercent: number;
  poolCount: number;
  minimumUses: number;
  mostUsedPercent: number;
  maxTagsToAdd: number;
  minProbability: number;
  maxBodyChars: number;
  skipShortNotes: boolean;
  minNoteWords: number;
  onlyTags: string;
  excludedTags: string;
  guidance: string;
  definitions: string;
}

export const DEFAULTS: Config = {
  provider: 'typesafe', typeSafeSecretId: '', apiKey: '', model: 'jev-latest', openRouterApiKey: '',
  openRouterSecretId: '', openRouterModel: '~typesafe/jev-latest',
  openAiApiKey: '', openAiSecretId: '', openAiModel: 'gpt-6-luna',
  geminiApiKey: '', geminiSecretId: '', geminiModel: 'gemini-decision-1',
  poolMode: 'auto', poolPercent: 20,
  poolCount: 100, minimumUses: 2, mostUsedPercent: 70,
  maxTagsToAdd: 5, minProbability: 0.75, maxBodyChars: 16000, skipShortNotes: true, minNoteWords: 20,
  onlyTags: '', excludedTags: '', guidance: '', definitions: '',
};

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeConfig(value: unknown): Config {
  const raw = record(value) ? value : {};
  const result = { ...DEFAULTS };
  for (const key of ['onlyTags', 'excludedTags', 'guidance', 'definitions'] as const) {
    if (typeof raw[key] === 'string') result[key] = raw[key];
  }
  for (const spec of Object.values(PROVIDERS)) {
    for (const key of [spec.keyField, spec.secretField, spec.modelField]) {
      if (typeof raw[key] === 'string') result[key] = raw[key].trim();
    }
    result[spec.modelField] ||= DEFAULTS[spec.modelField];
  }
  if (PROVIDER_NAMES.includes(raw.provider as Config['provider'])) result.provider = raw.provider as Config['provider'];
  if (typeof raw.skipShortNotes === 'boolean') result.skipShortNotes = raw.skipShortNotes;
  if (raw.poolMode === 'auto' || raw.poolMode === 'percent' || raw.poolMode === 'count' || raw.poolMode === 'minimum' || raw.poolMode === 'all' || raw.poolMode === 'specific') {
    result.poolMode = raw.poolMode;
  }
  const limits = {
    poolPercent: [1, 100], poolCount: [1, 1000000], minimumUses: [1, 1000000], mostUsedPercent: [0, 100],
    maxTagsToAdd: [1, 1000],
    minProbability: [0, 1], maxBodyChars: [200, 24000], minNoteWords: [1, 100000],
  } as const;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) continue;
    const [min, max] = limits[key];
    result[key] = Math.min(max, Math.max(min, key === 'minProbability' ? number : Math.round(number)));
  }
  return result;
}

type KeyField = 'apiKey' | 'openRouterApiKey' | 'openAiApiKey' | 'geminiApiKey';
export type PersistedConfig = Omit<Config, KeyField> & Partial<Pick<Config, KeyField>>;

export function persistedConfig(config: Config): PersistedConfig {
  const normalized = normalizeConfig(config);
  const { apiKey, openRouterApiKey, openAiApiKey: _openAiApiKey, geminiApiKey: _geminiApiKey, ...saved } = normalized;
  return {
    ...saved,
    ...(!normalized.typeSafeSecretId && apiKey ? { apiKey } : {}),
    ...(!normalized.openRouterSecretId && openRouterApiKey ? { openRouterApiKey } : {}),
  };
}
