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

test('flat Full Access shell calls allow runtime-defaulted metadata', () => {
  assert.deepEqual(
    parseShellToolCallPayload({ command: 'rg --files src' }),
    { command: 'rg --files src', arguments: [] },
  );
  assert.deepEqual(
    parseShellToolCallPayload({
      command: 'pnpm build',
      cwd: 'apps/desktop',
      timeoutMs: '120000',
    }),
    { command: 'pnpm build', arguments: [] },
  );
});

test('flat Full Access shell calls reject mixed argv and invalid metadata', () => {
  for (const value of [
    { command: 'rg --files', argvJson: '[]' },
    { command: 'rg --files', cwd: '' },
    { command: 'rg --files', timeoutMs: '120s' },
    { command: 'rg --files', kind: 'direct' },
  ]) {
    assert.throws(
      () => parseShellToolCallPayload(value),
      /Invalid shell\/exec ToolCall Item/u,
    );
  }
});
