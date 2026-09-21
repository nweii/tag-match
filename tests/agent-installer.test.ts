// Exercises the copied companion installer program against a mocked GitHub boundary and real temporary files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function install(directory: string, fail = false) {
  const installer = await readFile('scripts/install-cli.mjs', 'utf8');
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './tests/fixtures/installer-fetch-stub.mjs',
      '--input-type=module', '-', directory, '0.1.0'], {
      cwd: process.cwd(), env: { ...process.env, FAIL_DOWNLOAD: fail ? '1' : '' },
    });
    child.stdin.end(installer);
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stderr }));
  });
}

test('companion installer writes only both release assets and preserves data.json', async () => {
  const directory = await mkdtemp(join(tmpdir(), "tag match's plugin-"));
  await writeFile(join(directory, 'data.json'), '{"apiKey":"secret"}');
  const result = await install(directory);
  assert.equal(result.code, 0);
  assert.deepEqual((await readdir(directory)).sort(), ['AGENT-CLI.md', 'data.json', 'tag-match.mjs']);
  assert.equal(await readFile(join(directory, 'data.json'), 'utf8'), '{"apiKey":"secret"}');
  assert.equal(await readFile(join(directory, 'tag-match.mjs'), 'utf8'), 'cli fixture');
  assert.equal(await readFile(join(directory, 'AGENT-CLI.md'), 'utf8'), 'guide fixture');
});

test('companion installer fails HTTP errors before writing either asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-install-failure-'));
  await writeFile(join(directory, 'data.json'), '{}');
  const result = await install(directory, true);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 404/);
  assert.deepEqual(await readdir(directory), ['data.json']);
});
