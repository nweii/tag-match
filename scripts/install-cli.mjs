// Installs the optional CLI and guide from an exact Tag Match release without changing saved settings.
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

try {
  const [directory, version] = process.argv.slice(2);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or later, then run this command again.');
  if (!directory || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) {
    throw new Error('Provide the plugin folder and release version. Copy the command from Tag Match settings.');
  }
  if (!(await stat(directory)).isDirectory()) throw new Error('The plugin folder does not exist.');
  const names = ['tag-match.mjs', 'AGENT-CLI.md'];
  const base = `https://github.com/nweii/tag-match/releases/download/${encodeURIComponent(version)}/`;
  const contents = await Promise.all(names.map(async name => {
    const response = await fetch(base + name);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}. Check that release ${version} is published.`);
    return Buffer.from(await response.arrayBuffer());
  }));
  await Promise.all(names.map((name, index) => writeFile(join(directory, name), contents[index])));
  console.log('Tag Match agent CLI installed. Reload Tag Match in Obsidian.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
