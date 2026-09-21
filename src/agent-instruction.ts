// Builds desktop-only companion paths, a pinned installer command, and the instruction handed to an agent.
export interface AgentSetup { guidePath: string; installCommand: string }

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
    guidePath: `${pluginDirectory}/AGENT-CLI.md`,
    installCommand: `${download} | node --input-type=module - ${shellQuote(pluginDirectory, windows)} ${shellQuote(version, windows)}`,
  };
}

export function buildAgentInstruction(guidePath: string): string {
  return `For Tag Match tag review, applying reviewed tags, quick application, or generic decision queries, read "${guidePath}" and follow it through its completion checks.`;
}
