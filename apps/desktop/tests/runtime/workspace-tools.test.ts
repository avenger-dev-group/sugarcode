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

test('workspace_read partitions one compatible oversized batch without hiding paths', async () => {
  const requestedPaths: string[] = [];
  let activeReads = 0;
  let maximumActiveReads = 0;
  const paths = Array.from({ length: 10 }, (_, index) => `file-${index}.txt`);
  const tools = createWorkspaceTools(
    {
      workspaceRead: async (_workspaceId, path) => {
        requestedPaths.push(path);
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await Promise.resolve();
        activeReads -= 1;
        return JSON.stringify({ ok: true, content: path, bytes: path.length });
      },
    } as NativeRuntimeBinding,
    'workspace-fixture',
  );
  const readTool = tools.find((tool) => tool.name === 'workspace_read');
  assert.ok(readTool);

  const result = await readTool.runAsync({
    args: { paths },
    toolContext: {} as never,
  });

  assert.deepEqual(requestedPaths, paths);
  assert.equal(maximumActiveReads, 8);
  assert.equal(
    Array.isArray((result as { files?: unknown }).files)
      ? (result as { files: unknown[] }).files.length
      : 0,
    10,
  );
});

test('workspace_read rejects a batch above the compatibility hard limit', async () => {
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
  );
  const readTool = tools.find((tool) => tool.name === 'workspace_read');
  assert.ok(readTool);

  await assert.rejects(
    readTool.runAsync({
      args: {
        paths: Array.from(
          { length: 17 },
          (_, index) => `file-${index}.txt`,
        ),
      },
      toolContext: {} as never,
    }),
    /Requested 17 paths; the hard limit is 16/u,
  );
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
      'Use exactly one outer `*** Begin Patch` / `*** End Patch` pair around one or more `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path` operations. Do not put `*** End Patch` between file operations. GNU unified-diff headers are unsupported.',
  });
  assert.equal(approvalRequests, 0);
});

test('workspace_apply_patch rejects an early End Patch before approval', async () => {
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
        '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch',
    },
    toolContext: {} as never,
  });

  assert.equal((result as { error?: string }).error, 'invalidPatchFormat');
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

test('workspace_apply_patch rejects an identical replacement before approval', async () => {
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
        '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-console.debug("same");\n+console.debug("same");\n*** End Patch',
    },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'invalidPatchNoop',
    message:
      'A patch hunk removes and re-adds identical text, so it cannot change the file. To replace a line, prefix the existing workspace line with `-` and the different replacement line with `+`. Re-read the file first if the expected text has already changed.',
  });
  assert.equal(approvalRequests, 0);
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

test('shell_exec rejects a leading absolute cd before approval', async () => {
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
      mode: 'fullAccess',
      command: 'cd /home/user && pnpm test',
    },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'invalidArguments',
    message:
      'Full Access shell_exec already starts at the selected workspace root. Remove the leading absolute-path `cd`; use the workspace-relative cwd field for a real subdirectory.',
  });
  assert.equal(approvalRequests, 0);
});
