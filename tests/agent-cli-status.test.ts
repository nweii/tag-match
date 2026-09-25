// Verifies local CLI release markers and semantic-version status without executing the companion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCliVersion, compareVersions, resolveAgentCliStatus } from '../src/agent-instruction.ts';

test('CLI marker resolves current, older, newer, unknown, and missing states', () => {
  const source = (version: string) => `#!/usr/bin/env node\n// tag-match-cli-version: ${version}\n`;
  assert.equal(agentCliVersion(source('0.1.0')), '0.1.0');
  assert.deepEqual(resolveAgentCliStatus('0.1.0', source('0.1.0'), true), { kind: 'current', version: '0.1.0' });
  assert.deepEqual(resolveAgentCliStatus('0.1.0', source('0.0.9'), true), { kind: 'older', version: '0.0.9' });
  assert.deepEqual(resolveAgentCliStatus('0.1.0', source('0.2.0'), true), { kind: 'newer', version: '0.2.0' });
  assert.deepEqual(resolveAgentCliStatus('0.1.0', '#!/usr/bin/env node\n', true), { kind: 'unknown' });
  assert.deepEqual(resolveAgentCliStatus('0.1.0', null, true), { kind: 'missing' });
  assert.deepEqual(resolveAgentCliStatus('0.1.0', source('0.1.0'), false), { kind: 'missing' });
});

test('semantic comparison handles prereleases and ignores build metadata', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0);
});
