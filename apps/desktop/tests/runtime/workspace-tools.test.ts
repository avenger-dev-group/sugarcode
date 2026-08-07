import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeRuntimeBinding } from '../../src/runtime/native.ts';
import { createWorkspaceTools } from '../../src/runtime/tools/workspace.ts';

test('workspace_read accepts a bounded batch and preserves each path', async () => {
  const requestedPaths: string[] = [];
  const tools = createWorkspaceTools(
    {
      workspaceRead: async (_workspaceId, path) => {
        requestedPaths.push(path);
        return JSON.stringify({ ok: true, content: `content:${path}` });
      },
    } as NativeRuntimeBinding,
    'workspace-fixture',
  );
  const readTool = tools.find((tool) => tool.name === 'workspace_read');
  assert.ok(readTool);

  const result = await readTool.runAsync({
    args: { paths: ['README.md', 'package.json'] },
    toolContext: {} as never,
  });

  assert.deepEqual(requestedPaths, ['README.md', 'package.json']);
  assert.deepEqual(result, {
    ok: true,
    files: [
      { ok: true, content: 'content:README.md', path: 'README.md' },
      { ok: true, content: 'content:package.json', path: 'package.json' },
    ],
  });
});

test('workspace_apply_patch rejects unsupported diff syntax before approval', async () => {
  let approvalRequests = 0;
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async () => {
      approvalRequests += 1;
      return { ok: true };
    },
  );
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(patchTool);

  const result = await patchTool.runAsync({
    args: {
      patch:
        'Begin Patch\n--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-old\n+new\nEnd Patch',
    },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'invalidPatchFormat',
    message:
      'Use the SugarCode patch format: `*** Begin Patch`, one or more `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path` operations, then `*** End Patch`. GNU unified-diff headers are unsupported.',
  });
  assert.equal(approvalRequests, 0);
});

test('workspace_apply_patch rejects an unprefixed whole-file update before approval', async () => {
  let approvalRequests = 0;
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async () => {
      approvalRequests += 1;
      return { ok: true };
    },
  );
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(patchTool);

  const result = await patchTool.runAsync({
    args: {
      patch:
        '*** Begin Patch\n*** Update File: src/example.ts\nconst value = "new";\n*** End Patch',
    },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'invalidPatchUpdate',
    message:
      'Each `*** Update File:` body must contain changed lines: prefix removed lines with `-` and added lines with `+` (an optional `@@` context marker may come first). Do not paste the complete file body without diff prefixes. Example: `*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-old\\n+new\\n*** End Patch`.',
  });
  assert.equal(approvalRequests, 0);
});

test('workspace_apply_patch sends a valid update hunk to approval', async () => {
  let approvalRequests = 0;
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async (_toolName, argumentsValue) => {
      approvalRequests += 1;
      return { ok: true, argumentsValue };
    },
  );
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(patchTool);
  const patch =
    '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch';

  const result = await patchTool.runAsync({
    args: { patch },
    toolContext: {} as never,
  });

  assert.deepEqual(result, { ok: true, argumentsValue: { patch } });
  assert.equal(approvalRequests, 1);
});

test('shell_exec rejects sandboxed shell syntax with repair guidance before approval', async () => {
  let approvalRequests = 0;
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async () => {
      approvalRequests += 1;
      return { ok: true };
    },
  );
  const shellTool = tools.find((tool) => tool.name === 'shell_exec');
  assert.ok(shellTool);

  const result = await shellTool.runAsync({
    args: {
      mode: 'sandboxed',
      command: 'find src -type f | head -100',
      arguments: [],
    },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'invalidArguments',
    message:
      'Sandboxed shell_exec requires command to be one absolute executable path and accepts its arguments only through the arguments array. Use fullAccess for pipes, redirects, command chaining, or other shell syntax.',
  });
  assert.equal(approvalRequests, 0);
});
