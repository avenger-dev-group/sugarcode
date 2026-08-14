import assert from 'node:assert/strict';
import test from 'node:test';

import { commandApprovalDisplayCommand } from '../../../src/renderer/components/command-approval/presentation.ts';

test('shell approvals display the executable command without transport metadata', () => {
  assert.equal(
    commandApprovalDisplayCommand({
      operationKind: 'shell',
      command: 'Full Access: curl -I https://example.com',
    }),
    'curl -I https://example.com',
  );
  assert.equal(
    commandApprovalDisplayCommand({
      operationKind: 'shell',
      command: 'Sandboxed: pnpm check',
    }),
    'pnpm check',
  );
});

test('file approval summaries remain unchanged', () => {
  const summary = '2 workspace file changes\nUpdate src/a.ts\nCreate src/b.ts';
  assert.equal(
    commandApprovalDisplayCommand({
      operationKind: 'workspacePatch',
      command: summary,
    }),
    summary,
  );
});
