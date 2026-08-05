import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCommandApprovalRequest } from '../../../../src/main/app-server/command-approval/protocol.ts';

test('sandboxed direct accepts the authoritative absolute cwd', () => {
  const approvalId = 'approval/thread/turn/call';
  const request = parseCommandApprovalRequest(
    approvalId,
    {
      approvalId,
      workspaceId: 'a'.repeat(64),
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      description: 'Check the installed Node version.',
      command: '/usr/bin/env',
      arguments: ['node', '--version'],
      cwd: '/Users/simonf/Documents/wwwroot/aixvo/aixvo-link-web',
      approvalScope: 'command',
      environmentPolicy: 'hostInheritedV1',
      sandboxed: true,
      sandboxPolicy: 'filesystemReadOnlyV1',
      networkPolicy: 'networkDeniedV1',
    },
    'darwin',
  );

  assert.equal(request?.environmentPolicy, 'hostInheritedV1');
  assert.equal(
    request?.cwd,
    '/Users/simonf/Documents/wwwroot/aixvo/aixvo-link-web',
  );
});

test('Full Access shell accepts command syntax without sandbox policies', () => {
  const approvalId = 'approval/thread/turn/full-shell';
  const request = parseCommandApprovalRequest(
    approvalId,
    {
      approvalId,
      workspaceId: 'b'.repeat(64),
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      description: 'Run the approved build pipeline.',
      command: 'pnpm build && printf "$PWD\\n" | tee build.log',
      arguments: [],
      cwd: '/Users/simonf/Documents/wwwroot/aixvo/aixvo-link-web',
      approvalScope: 'command',
      environmentPolicy: 'hostInheritedV1',
      sandboxed: false,
    },
    'darwin',
  );

  assert.equal(request?.sandboxed, false);
  assert.equal(request?.command.includes('&&'), true);
  assert.equal(request?.sandboxPolicy, undefined);
  assert.equal(request?.networkPolicy, undefined);
  assert.equal(
    request?.cwd,
    '/Users/simonf/Documents/wwwroot/aixvo/aixvo-link-web',
  );
});

test('Windows Full Access cwd accepts a local absolute root and rejects unsafe paths', () => {
  const approvalId = 'approval/thread/turn/windows-shell';
  const base = {
    approvalId,
    workspaceId: 'c'.repeat(64),
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    description: 'Run the approved Windows command.',
    command: 'echo %CD% && dir *.txt',
    arguments: [],
    approvalScope: 'command',
    environmentPolicy: 'hostInheritedV1',
    sandboxed: false,
  } as const;

  assert.equal(
    parseCommandApprovalRequest(
      approvalId,
      { ...base, cwd: 'apps\\desktop' },
      'win32',
    )?.cwd,
    'apps\\desktop',
  );
  assert.equal(
    parseCommandApprovalRequest(
      approvalId,
      { ...base, cwd: 'C:\\workspace\\aixvo-link-web' },
      'win32',
    )?.cwd,
    'C:\\workspace\\aixvo-link-web',
  );
  for (const cwd of [
    '..\\outside',
    'apps\\..\\outside',
    '\\\\server\\share',
    '\\\\?\\C:\\outside',
  ]) {
    assert.equal(
      parseCommandApprovalRequest(approvalId, { ...base, cwd }, 'win32'),
      null,
    );
  }
});
