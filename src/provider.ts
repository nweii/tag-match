// Resolves one saved decision provider into an isolated endpoint, credential, model, and user-facing identity.
import type { Config } from './config.ts';

export type ProviderName = Config['provider'];
export interface ProviderConfig {
  name: ProviderName;
  label: 'TypeSafe' | 'OpenRouter';
  attribution: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

export const TYPE_SAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const OPEN_ROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

export function resolveProvider(config: Config): ProviderConfig {
  if (config.provider === 'openrouter') return {
    name: 'openrouter', label: 'OpenRouter', attribution: `Using ${config.openRouterModel} · OpenRouter`,
    endpoint: OPEN_ROUTER_ENDPOINT, apiKey: config.openRouterApiKey, model: config.openRouterModel,
  };
  return {
    name: 'typesafe', label: 'TypeSafe', attribution: `Using ${config.model} · TypeSafe`,
    endpoint: TYPE_SAFE_ENDPOINT, apiKey: config.apiKey, model: config.model,
  };
}
