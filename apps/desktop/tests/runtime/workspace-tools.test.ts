import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeRuntimeBinding } from '../../src/runtime/native.ts';
import {
  createWorkspaceTools,
  executePrivilegedWorkspaceTool,
  workspacePatchApprovalSummary,
} from '../../src/runtime/tools/workspace.ts';
import { WorkspaceInstructionContext } from '../../src/runtime/workspace-instructions.ts';

test('workspace patch approval summary describes file effects without internal tool names', () => {
  assert.equal(
    workspacePatchApprovalSummary(
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+new\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n*** End Patch',
    ),
    '3 workspace file changes\nUpdate src/a.ts\nCreate src/b.ts\nMove src/old.ts -> src/new.ts',
  );
  assert.doesNotMatch(
    workspacePatchApprovalSummary(
      '*** Begin Patch\n*** Delete File: obsolete.txt\n*** End Patch',
    ),
    /workspace_apply_patch/u,
  );
  const unicodeSummary = workspacePatchApprovalSummary(
    `*** Begin Patch\n${Array.from(
      { length: 12 },
      (_, index) => `*** Add File: src/${'界'.repeat(120)}-${index}.txt\n+new`,
    ).join('\n')}\n*** End Patch`,
  );
  assert.ok(Buffer.byteLength(unicodeSummary, 'utf8') <= 1_024);
});

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

test('workspace reads continue with instruction warnings while writes stop before approval', async () => {
  let approvalRequests = 0;
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      return JSON.stringify({
        contractVersion: 1,
        documents: [],
        chains: [],
        errors: scopes.map((scope) => ({ scope, kind: 'invalidEncoding' })),
      });
    },
    workspaceRead: async () => JSON.stringify({ ok: true, content: 'fixture' }),
  } as unknown as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace-fixture');
  const tools = createWorkspaceTools(
    native,
    'workspace-fixture',
    async () => {
      approvalRequests += 1;
      return { ok: true };
    },
    undefined,
    'workspaceWrite',
    context,
  );
  const readTool = tools.find((tool) => tool.name === 'workspace_read');
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(readTool);
  assert.ok(patchTool);

  const read = await readTool.runAsync({
    args: { path: 'src/example.ts' },
    toolContext: {} as never,
  }) as Record<string, unknown>;
  assert.equal(read.ok, true);
  assert.deepEqual(read.workspaceInstructionsWarning, [{
    scope: 'src',
    kind: 'invalidEncoding',
  }]);

  const write = await patchTool.runAsync({
    args: {
      patch:
        '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
    },
    toolContext: {} as never,
  }) as Record<string, unknown>;
  assert.equal(write.error, 'workspaceInstructionsUnavailable');
  assert.equal(approvalRequests, 0);
});

test('workspace patch revalidates project instructions after approval before writing', async () => {
  let version = 1;
  let nativeWrites = 0;
  const native = {
    workspaceInstructionsJson: (_workspaceId: string, scopesJson: string) => {
      const scopes = JSON.parse(scopesJson) as string[];
      const root = {
        path: 'AGENTS.md',
        scope: '.',
        content: `Rules version ${version}.`,
        bytes: 16,
        sha256: String(version).repeat(64),
      };
      return JSON.stringify({
        contractVersion: 1,
        documents: [root],
        chains: scopes.map((scope) => ({ scope, paths: ['AGENTS.md'] })),
        errors: [],
      });
    },
    workspaceApplyPatch: async () => {
      nativeWrites += 1;
      return JSON.stringify({ ok: true });
    },
  } as unknown as NativeRuntimeBinding;
  const context = new WorkspaceInstructionContext(native, 'workspace-fixture');
  context.preloadRoot();
  context.injectIntoRequest({
    model: 'fixture',
    contents: [{ role: 'user', parts: [{ text: 'Initial request.' }] }],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
  });
  const tools = createWorkspaceTools(
    native,
    'workspace-fixture',
    async (_toolName, _argumentsValue, execute) => {
      version = 2;
      return execute('operation-fixture');
    },
    undefined,
    'workspaceWrite',
    context,
  );
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(patchTool);

  const result = await patchTool.runAsync({
    args: {
      patch:
        '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
    },
    toolContext: {} as never,
  }) as Record<string, unknown>;

  assert.equal(result.error, 'workspaceInstructionsRequired');
  assert.equal(nativeWrites, 0);
});

test('workspace_read explains that directory paths belong to workspace_list', async () => {
  const tools = createWorkspaceTools(
    {
      workspaceRead: async (workspaceId, path) => {
        void workspaceId;
        void path;
        return JSON.stringify({
          ok: false,
          error: 'notRegularFile',
        });
      },
    } as NativeRuntimeBinding,
    'workspace-fixture',
  );
  const readTool = tools.find((tool) => tool.name === 'workspace_read');
  assert.ok(readTool);

  const result = await readTool.runAsync({
    args: { path: 'src/components' },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'notRegularFile',
    message:
      'src/components is not a regular file. If it is a directory, inspect it with workspace_list and read only returned entries whose kind is file.',
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
      'Use a SugarCode `*** Begin Patch` / file-operation / `*** End Patch` document containing at least one `*** Add File: path`, `*** Update File: path`, or `*** Delete File: path` operation. GNU unified-diff headers are unsupported.',
  });
  assert.equal(approvalRequests, 0);
});

test('workspace_apply_patch normalizes repeated file envelopes before approval', async () => {
  let approvalRequests = 0;
  let approvedPatch = '';
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async (_toolName, argumentsValue) => {
      approvalRequests += 1;
      approvedPatch = String(argumentsValue.patch);
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

  assert.deepEqual(result, { ok: true });
  assert.equal(approvalRequests, 1);
  assert.equal(
    approvedPatch,
    '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch',
  );
});

test('workspace_apply_patch unwraps common fenced and heredoc documents before approval', async () => {
  const approved: string[] = [];
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async (_toolName, argumentsValue) => {
      approved.push(String(argumentsValue.patch));
      return { ok: true };
    },
  );
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(patchTool);
  const patch =
    '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';

  await patchTool.runAsync({
    args: { patch: `\`\`\`patch\n${patch}\n\`\`\`` },
    toolContext: {} as never,
  });
  await patchTool.runAsync({
    args: { patch: `apply_patch <<'PATCH'\n${patch}\nPATCH` },
    toolContext: {} as never,
  });

  assert.deepEqual(approved, [patch, patch]);
});

test('workspace_apply_patch explains the exact stale file without mutating any file', async () => {
  const patch =
    '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Update File: src/b.ts\n@@\n-stale\n+fresh\n*** End Patch';
  const result = await executePrivilegedWorkspaceTool(
    {
      workspaceApplyPatch: async () => JSON.stringify({
        ok: false,
        error: 'ExpectedMismatch',
        operationIndex: 1,
        diagnostic: { line: 42, suggestedAction: 'readFileAndRebase' },
      }),
    } as unknown as NativeRuntimeBinding,
    'operation-fixture',
    'workspace-fixture',
    'workspace_apply_patch',
    { patch },
  );

  assert.deepEqual(result, {
    ok: false,
    error: 'ExpectedMismatch',
    operationIndex: 1,
    diagnostic: { line: 42, suggestedAction: 'readFileAndRebase' },
    failedPath: 'src/b.ts',
    message:
      'Patch context for `src/b.ts` did not match the current workspace near line 42. No files were changed because the patch is atomic. Re-read `src/b.ts` and retry that file in a small patch.',
  });
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

test('workspace_apply_patch does not treat raw Add File content as an update no-op', async () => {
  let approvedPatch = '';
  const tools = createWorkspaceTools(
    {} as NativeRuntimeBinding,
    'workspace-fixture',
    async (_toolName, argumentsValue) => {
      approvedPatch = String(argumentsValue.patch);
      return { ok: true };
    },
  );
  const patchTool = tools.find((tool) => tool.name === 'workspace_apply_patch');
  assert.ok(patchTool);
  const patch =
    '*** Begin Patch\n*** Add File: fixture.txt\n-same\n+same\n*** End Patch';

  assert.deepEqual(
    await patchTool.runAsync({
      args: { patch },
      toolContext: {} as never,
    }),
    { ok: true },
  );
  assert.equal(approvedPatch, patch);
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

test('shell_exec rejects find predicates without an explicit search root', async () => {
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
      command: '/usr/bin/find',
      arguments: ['-name', 'AGENTS.md'],
    },
    toolContext: {} as never,
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'invalidArguments',
    message:
      'Sandboxed find requires an explicit search path as its first argument (usually ".") before predicates such as -name. Prefer workspace_search for workspace file discovery.',
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
