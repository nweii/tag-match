// Resolves provider credentials without exposing their values through saved plugin data or process arguments.
import { spawn } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import type { Config } from '../../src/config.ts';

export type CredentialProvider = Config['provider'];
const details = (provider: CredentialProvider) => provider === 'openrouter'
  ? { key: 'openRouterApiKey' as const, reference: 'openRouterSecretId' as const, env: 'OPENROUTER_API_KEY', id: 'tag-match-openrouter' }
  : { key: 'apiKey' as const, reference: 'typeSafeSecretId' as const, env: 'TYPESAFE_API_KEY', id: 'tag-match-typesafe' };

export function vaultDirectory(configPath: string): string | null {
  const absolute = resolve(configPath); const parts = absolute.split(sep);
  if (parts.at(-1) !== 'data.json' || parts.at(-3) !== 'plugins') return null;
  return dirname(dirname(dirname(dirname(absolute))));
}

type Runner = (command: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;
const run: Runner = (command, args, options) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; const timer = setTimeout(() => child.kill(), 10_000);
  child.stdout.setEncoding('utf8').on('data', chunk => {
    if (stdout.length < 64_000) stdout += String(chunk).slice(0, 64_000 - stdout.length);
  });
  child.stderr.resume();
  child.on('error', reject);
  child.on('close', code => {
    clearTimeout(timer);
    code === 0 ? resolveRun({ stdout }) : reject(new Error(`Obsidian CLI exited with code ${code}.`));
  });
});

export async function resolveCliCredential(config: Config, configPath: string,
  environment: Record<string, string | undefined> = process.env, runner: Runner = run): Promise<Config> {
  const item = details(config.provider); const envKey = environment[item.env]?.trim();
  if (envKey) return { ...config, [item.key]: envKey };
  if (config[item.key]) return config;
  const id = config[item.reference]; const cwd = vaultDirectory(configPath);
  if (!id || !cwd) throw new Error(`Set ${item.env}, or use a Tag Match config inside a vault with a saved Obsidian Secret.`);
  const expression = `JSON.stringify({tagMatchVault:app.vault.adapter.getBasePath(),tagMatchSecret:app.secretStorage.getSecret(${JSON.stringify(id)})})`;
  let stdout: string;
  try { ({ stdout } = await runner('obsidian', ['eval', `code=${expression}`], { cwd })); }
  catch { throw new Error(`Could not read the saved Obsidian Secret. Open Obsidian for this vault or set ${item.env}.`); }
  const match = stdout.match(/\{\s*"tagMatchVault"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"tagMatchSecret"\s*:\s*(?:"(?:\\.|[^"\\])*"|null)\s*\}/g)?.at(-1);
  if (!match) throw new Error(`Obsidian did not return the saved secret. Set ${item.env} and try again.`);
  const result = JSON.parse(match) as { tagMatchVault: string; tagMatchSecret: string | null };
  if (resolve(result.tagMatchVault) !== resolve(cwd)) throw new Error('Obsidian opened a different vault. Open the configured vault and try again.');
  const value = result.tagMatchSecret?.trim();
  if (!value) throw new Error(`The selected Obsidian Secret is empty. Choose another secret or set ${item.env}.`);
  return { ...config, [item.key]: value };
}
