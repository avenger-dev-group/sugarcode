import assert from 'node:assert/strict';
import test from 'node:test';

import { collectTurnVerifiedFilePaths } from '../../../src/renderer/components/thread/verified-file-paths.ts';
import type { ConversationTurn } from '../../../src/shared/conversation.ts';

const completedRead = (
  id: string,
  path: string,
  outcome: 'success' | 'error' = 'success',
) => ({
  id,
  callId: `${id}:call`,
  path,
  callStatus: 'completed' as const,
  result: {
    id: `${id}:result`,
    status: 'completed' as const,
    outcome:
      outcome === 'success'
        ? ({ type: 'success' as const, bytes: 42 })
        : ({ type: 'error' as const, kind: 'notFound' }),
  },
});

test('verified paths include successful reads and applied files only', () => {
  const turn: ConversationTurn = {
    id: 'turn-1',
    status: 'completed',
    messages: [],
    activities: [
      { type: 'workspaceRead', activity: completedRead('read-1', 'src/one.ts') },
      {
        type: 'workspaceRead',
        activity: completedRead('read-2', 'src/missing.ts', 'error'),
      },
      {
        type: 'commandApproval',
        activity: {
          callItemId: 'patch:call-item',
          id: 'patch',
          callId: 'patch:call',
          approvalId: 'patch:approval',
          command: 'workspace_apply_patch',
          argumentCount: 1,
          requestStatus: 'completed',
          executionResult: {
            id: 'patch:result',
            status: 'completed',
            outcome: {
              type: 'workspacePatch',
              filesChanged: 2,
              files: [
                {
                  path: 'src/two.ts',
                  kind: 'update',
                  beforeSha256: 'a'.repeat(64),
                  afterSha256: 'b'.repeat(64),
                  beforeBytes: 1,
                  afterBytes: 2,
                },
                {
                  path: 'src/one.ts',
                  kind: 'delete',
                  beforeSha256: 'a'.repeat(64),
                  afterSha256: 'b'.repeat(64),
                  beforeBytes: 1,
                  afterBytes: 0,
                },
              ],
            },
          },
        },
      },
    ],
  };

  assert.deepEqual(collectTurnVerifiedFilePaths(turn), ['src/two.ts']);
});
