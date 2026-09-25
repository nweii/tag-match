// Builds desktop-only companion paths, a pinned installer command, and the instruction handed to an agent.
export interface AgentSetup { cliPath: string; guidePath: string; installCommand: string }
export type AgentCliStatus =
  | { kind: 'missing' }
  | { kind: 'current' | 'older' | 'newer'; version: string }
  | { kind: 'unknown' };

export function agentCliVersion(source: string): string | null {
  return source.match(/^\/\/ tag-match-cli-version: (\S+)$/m)?.[1] ?? null;
}

function semverParts(version: string): { core: number[]; prerelease: string[] | null } | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? null };
}

export function compareVersions(left: string, right: string): number | null {
  const a = semverParts(left); const b = semverParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index]! - b.core[index]!);
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const av = a.prerelease[index]; const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av); const bn = /^\d+$/.test(bv);
    if (an && bn) return Math.sign(Number(av) - Number(bv));
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function resolveAgentCliStatus(expectedVersion: string, cliSource: string | null,
  guideInstalled: boolean): AgentCliStatus {
  if (cliSource === null || !guideInstalled) return { kind: 'missing' };
  const version = agentCliVersion(cliSource);
  if (!version) return { kind: 'unknown' };
  const comparison = compareVersions(version, expectedVersion);
  if (comparison === null) return { kind: 'unknown' };
  return { kind: comparison === 0 ? 'current' : comparison < 0 ? 'older' : 'newer', version };
}

function shellQuote(value: string, windows: boolean): string {
  return windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveAgentSetup(
  isDesktop: boolean,
  basePath: string | null,
  configDir: string,
  pluginId: string,
  version: string,
  windows: boolean,
): AgentSetup | null {
  if (!isDesktop || !basePath) return null;
  const pluginDirectory = `${basePath}/${configDir}/plugins/${pluginId}`;
  const url = `https://github.com/nweii/tag-match/releases/download/${encodeURIComponent(version)}/install-cli.mjs`;
  const download = windows ? `(Invoke-WebRequest -Uri ${shellQuote(url, true)}).Content` : `curl -fsSL ${shellQuote(url, false)}`;
  return {
    cliPath: `${pluginDirectory}/tag-match.mjs`,
    guidePath: `${pluginDirectory}/AGENT-CLI.md`,
    installCommand: `${download} | node --input-type=module - ${shellQuote(pluginDirectory, windows)} ${shellQuote(version, windows)}`,
  };
}

export function buildAgentInstruction(guidePath: string): string {
  return `For Tag Match tag review, applying reviewed tags, quick application, or generic decision queries, read "${guidePath}" and follow it through its completion checks.`;
}
