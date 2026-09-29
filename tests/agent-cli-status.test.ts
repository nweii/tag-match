// Verifies local CLI build identity without executing the installed companion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCliIdentity, agentCliVersion, compareVersions, resolveAgentCliStatus } from '../src/agent-instruction.ts';

const identityA = `sha256:${'a'.repeat(64)}`;
const identityB = `sha256:${'b'.repeat(64)}`;
const source = (version: string, identity?: string) =>
  `#!/usr/bin/env node\n// tag-match-cli-version: ${version}\n${identity ? `// tag-match-cli-identity: ${identity}\n` : ''}`;

test('build identity determines CLI status independently of release version', () => {
  assert.equal(agentCliVersion(source('0.1.0', identityA)), '0.1.0');
  assert.equal(agentCliIdentity(source('0.1.0', identityA)), identityA);
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.1.0', identityA), true),
    { kind: 'current', version: '0.1.0' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.2.0', identityA), true),
    { kind: 'current', version: '0.2.0' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.1.0', identityB), true),
    { kind: 'different', version: '0.1.0' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.2.0', identityB), true),
    { kind: 'newer', version: '0.2.0' });
});

test('legacy and unreadable identities stay uncertain; missing files stay missing', () => {
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.0.9'), true),
    { kind: 'unknown', version: '0.0.9' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.2.0'), true),
    { kind: 'newer', version: '0.2.0' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', '#!/usr/bin/env node\n', true),
    { kind: 'unknown', version: null });
  assert.deepEqual(resolveAgentCliStatus(null, '0.1.2', source('0.1.0', identityA), true),
    { kind: 'unknown', version: '0.1.0' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', null, true), { kind: 'missing' });
  assert.deepEqual(resolveAgentCliStatus(identityA, '0.1.2', source('0.1.0', identityA), false), { kind: 'missing' });
});

test('version comparison distinguishes prereleases and rejects uncertain versions', () => {
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0);
  assert.equal(compareVersions('local', '1.0.0'), null);
});
