import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeRuntimeBinding } from '../../src/runtime/native.ts';
import { createWorkspaceTools } from '../../src/runtime/tools/workspace.ts';

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
