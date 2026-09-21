// Migrates legacy provider keys into Obsidian SecretStorage and hydrates runtime-only credential values.
import type { Config } from './config.ts';

export interface SecretStore { getSecret(id: string): string | null; listSecrets(): string[]; setSecret(id: string, value: string): void }
const details = (provider: Config['provider']) => provider === 'openrouter'
  ? { key: 'openRouterApiKey' as const, reference: 'openRouterSecretId' as const, id: 'tag-match-openrouter' }
  : { key: 'apiKey' as const, reference: 'typeSafeSecretId' as const, id: 'tag-match-typesafe' };

export function hydrateCredentials(config: Config, secrets: Pick<SecretStore, 'getSecret'>): Config {
  const next = { ...config };
  for (const provider of ['typesafe', 'openrouter'] as const) {
    const item = details(provider); const id = next[item.reference];
    next[item.key] = id ? secrets.getSecret(id)?.trim() ?? '' : next[item.key];
  }
  return next;
}

export function migrateLegacyCredentials(config: Config, secrets: SecretStore): { config: Config; changed: boolean } {
  const next = { ...config }; let changed = false;
  for (const provider of ['typesafe', 'openrouter'] as const) {
    const item = details(provider); const source = next[item.key].trim();
    if (!source || next[item.reference]) continue;
    try {
      let id = item.id; let suffix = 2;
      while (secrets.listSecrets().includes(id) && secrets.getSecret(id) !== source) id = `${item.id}-${suffix++}`;
      secrets.setSecret(id, source);
      if (secrets.getSecret(id) !== source) continue;
      next[item.reference] = id; next[item.key] = source; changed = true;
    } catch { /* Keep the legacy value in data.json when migration cannot be verified. */ }
  }
  return { config: next, changed };
}
