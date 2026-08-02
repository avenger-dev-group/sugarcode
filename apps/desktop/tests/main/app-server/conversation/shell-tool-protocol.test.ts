import assert from 'node:assert/strict';
import test from 'node:test';

import { parseShellToolCallPayload } from '../../../../src/main/app-server/conversation/shell-tool-protocol.ts';

test('argvJson shell calls are normalized for Desktop presentation', () => {
  const payload = parseShellToolCallPayload({
    description: 'Check the installed Node version.',
    command: '/usr/bin/env',
    argvJson: '["node","--version"]',
    cwd: '.',
  });

  assert.deepEqual(payload, {
    command: '/usr/bin/env',
    arguments: ['node', '--version'],
  });
});

test('legacy shell argument arrays remain readable', () => {
  const payload = parseShellToolCallPayload({
    description: 'Check the installed Java version.',
    command: '/usr/bin/java',
    arguments: ['--version'],
    cwd: '.',
  });

  assert.deepEqual(payload.arguments, ['--version']);
});
