// Verifies credential migration and CLI resolution at their public configuration boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, persistedConfig } from '../src/config.ts';
import { migrateLegacyCredentials } from '../src/secret-storage.ts';
import { resolveCliCredential } from '../scripts/cli/credentials.ts';

test('verified migration uses a distinct secret and removes only migrated raw keys', () => {
  const values = new Map([['tag-match-typesafe', 'someone-elses-key']]);
  const secrets = {
    listSecrets: () => [...values.keys()], getSecret: (id: string) => values.get(id) ?? null,
    setSecret: (id: string, value: string) => { values.set(id, value); },
  };
  const migrated = migrateLegacyCredentials({ ...DEFAULTS, apiKey: 'type-key', openRouterApiKey: 'router-key' }, secrets);
  assert.equal(migrated.config.typeSafeSecretId, 'tag-match-typesafe-2');
  assert.equal(migrated.config.openRouterSecretId, 'tag-match-openrouter');
  assert.deepEqual(values.get('tag-match-typesafe'), 'someone-elses-key');
  const saved = persistedConfig(migrated.config) as Record<string, unknown>;
  assert.equal('apiKey' in saved, false); assert.equal('openRouterApiKey' in saved, false);
});

test('failed migration preserves its source through an ordinary settings save', () => {
  const values = new Map<string, string>();
  const migrated = migrateLegacyCredentials({ ...DEFAULTS, apiKey: 'type-key', openRouterApiKey: 'router-key' }, {
    listSecrets: () => [...values.keys()], getSecret: id => values.get(id) ?? null,
    setSecret: (id, value) => { if (id.includes('openrouter')) throw new Error('write failed'); values.set(id, value); },
  });
  const saved = persistedConfig({ ...migrated.config, poolCount: 42 }) as unknown as Record<string, unknown>;
  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.openRouterApiKey, 'router-key');
});

test('CLI environment credentials remain provider-specific', async () => {
  const openRouter = await resolveCliCredential({ ...DEFAULTS, provider: 'openrouter' }, '/tmp/data.json', {
    TYPESAFE_API_KEY: 'wrong-provider', OPENROUTER_API_KEY: 'router-key',
  });
  assert.equal(openRouter.openRouterApiKey, 'router-key'); assert.equal(openRouter.apiKey, '');
  await assert.rejects(resolveCliCredential({ ...DEFAULTS, provider: 'openrouter' }, '/tmp/data.json', {
    TYPESAFE_API_KEY: 'wrong-provider',
  }), /OPENROUTER_API_KEY/);
});

test('CLI asks the matching running vault for only the saved secret reference', async () => {
  let invocation: { command: string; args: string[]; cwd: string } | undefined;
  const configPath = '/Vault/settings/plugins/tag-match/data.json';
  const resolved = await resolveCliCredential({ ...DEFAULTS, typeSafeSecretId: 'tag-match-typesafe' }, configPath, {},
    async (command, args, options) => {
      invocation = { command, args, cwd: options.cwd };
      return { stdout: 'Obsidian CLI\n{"tagMatchVault":"/Vault","tagMatchSecret":"secret-value"}\n' };
    });
  assert.equal(resolved.apiKey, 'secret-value');
  assert.deepEqual(invocation, { command: 'obsidian', cwd: '/Vault', args: ['eval',
    'code=JSON.stringify({tagMatchVault:app.vault.adapter.getBasePath(),tagMatchSecret:app.secretStorage.getSecret("tag-match-typesafe")})'] });
});

test('CLI rejects a secret returned by a different vault', async () => {
  await assert.rejects(resolveCliCredential({ ...DEFAULTS, typeSafeSecretId: 'tag-match-typesafe' },
    '/Vault/settings/plugins/tag-match/data.json', {}, async () => ({
      stdout: '{"tagMatchVault":"/Other","tagMatchSecret":"wrong-vault-secret"}',
    })), /different vault/);
});
