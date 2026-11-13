// Describes each decision provider once: its endpoint, wire protocol, authentication, and where its settings live.
import type { Config } from './config.ts';

export type ProviderName = Config['provider'];
export type Protocol = 'systemone' | 'openai' | 'gemini';
type KeyField = 'apiKey' | 'openRouterApiKey' | 'openAiApiKey' | 'geminiApiKey';
type SecretField = 'typeSafeSecretId' | 'openRouterSecretId' | 'openAiSecretId' | 'geminiSecretId';
type ModelField = 'model' | 'openRouterModel' | 'openAiModel' | 'geminiModel';

export interface ProviderSpec {
  label: string;
  site: string;
  modelsUrl: string;
  endpoint: string;
  protocol: Protocol;
  headers: (apiKey: string) => Record<string, string>;
  keyField: KeyField;
  secretField: SecretField;
  modelField: ModelField;
  secretId: string;
  env: string;
}

const bearer = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });

export const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  typesafe: { label: 'TypeSafe', site: 'https://typesafe.ai', modelsUrl: 'https://docs.typesafe.ai/models',
    endpoint: 'https://api.typesafe.ai/v1/systemone', protocol: 'systemone', headers: bearer,
    keyField: 'apiKey', secretField: 'typeSafeSecretId', modelField: 'model', secretId: 'tag-match-typesafe', env: 'TYPESAFE_API_KEY' },
  openrouter: { label: 'OpenRouter', site: 'https://openrouter.ai', modelsUrl: 'https://openrouter.ai/models?fmt=cards&output_modalities=decisions',
    endpoint: 'https://openrouter.ai/api/alpha/decisions', protocol: 'systemone', headers: bearer,
    keyField: 'openRouterApiKey', secretField: 'openRouterSecretId', modelField: 'openRouterModel', secretId: 'tag-match-openrouter', env: 'OPENROUTER_API_KEY' },
  openai: { label: 'OpenAI', site: 'https://platform.openai.com', modelsUrl: 'https://developers.openai.com/api/docs/guides/decisions#how-decisions-work',
    endpoint: 'https://api.openai.com/v1/decisions', protocol: 'openai', headers: bearer,
    keyField: 'openAiApiKey', secretField: 'openAiSecretId', modelField: 'openAiModel', secretId: 'tag-match-openai', env: 'OPENAI_API_KEY' },
  gemini: { label: 'Gemini', site: 'https://aistudio.google.com', modelsUrl: 'https://aistudio.google.com/docs/models/gemini-decision-1',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/decisions', protocol: 'gemini', headers: apiKey => ({ 'x-goog-api-key': apiKey }),
    keyField: 'geminiApiKey', secretField: 'geminiSecretId', modelField: 'geminiModel', secretId: 'tag-match-gemini', env: 'GEMINI_API_KEY' },
};

export const TYPE_SAFE_ENDPOINT = PROVIDERS.typesafe.endpoint;
export const OPEN_ROUTER_ENDPOINT = PROVIDERS.openrouter.endpoint;
export const OPEN_AI_ENDPOINT = PROVIDERS.openai.endpoint;
export const GEMINI_ENDPOINT = PROVIDERS.gemini.endpoint;

export interface ProviderConfig {
  name: ProviderName;
  label: string;
  protocol: Protocol;
  attribution: string;
  endpoint: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
}

export function resolveProvider(config: Config): ProviderConfig {
  const spec = PROVIDERS[config.provider];
  const apiKey = config[spec.keyField];
  const model = config[spec.modelField];
  return { name: config.provider, label: spec.label, protocol: spec.protocol, attribution: `Using ${model} · ${spec.label}`,
    endpoint: spec.endpoint, apiKey, headers: spec.headers(apiKey), model };
}
