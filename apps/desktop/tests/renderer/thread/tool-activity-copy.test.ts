import assert from 'node:assert/strict';
import test from 'node:test';

import { toolActivityGroupSummary } from '../../../src/renderer/components/thread/tool-activity-copy.ts';
import {
  commandActivityAction,
  commandActivityFailed,
} from '../../../src/renderer/components/thread/tool-activity.ts';
import type { CompactToolActivity } from '../../../src/renderer/components/thread/types.ts';

const activities = [
  {
    type: 'workspaceList',
    activity: { id: 'list', path: '.', state: 'succeeded' },
  },
  {
    type: 'workspaceRead',
    activity: { id: 'read-1', path: 'README.md', state: 'succeeded' },
  },
  {
    type: 'workspaceRead',
    activity: { id: 'read-2', path: 'package.json', state: 'succeeded' },
  },
  {
    type: 'workspaceSearch',
    activity: {
      id: 'search',
      path: '.',
      query: 'SugarCode',
      state: 'succeeded',
    },
  },
] satisfies readonly CompactToolActivity[];

test('tool activity summaries follow the Turn process language', () => {
  assert.equal(
    toolActivityGroupSummary(activities, 'zh'),
    '已列出 1 个目录、已读取 2 个文件、完成 1 次搜索',
  );
  assert.equal(
    toolActivityGroupSummary(activities, 'en'),
    'Listed a directory, read 2 files and searched the workspace',
  );
});

test('successful workspace patches are presented as edits, not failed commands', () => {
  const patchActivity = {
    type: 'commandApproval',
    activity: {
      id: 'patch-approval',
      command: 'workspace_apply_patch (324 bytes)',
      argumentCount: 0,
      state: 'approved',
      executionAttempt: { id: 'patch-attempt', state: 'recorded' },
      executionResult: {
        id: 'patch-result',
        state: 'recorded',
        outcome: { type: 'workspacePatch', filesChanged: 3 },
      },
    },
  } satisfies CompactToolActivity;

  assert.equal(commandActivityFailed(patchActivity), false);
  assert.equal(
    commandActivityAction(patchActivity, false, false, 'zh'),
    '已编辑',
  );
  assert.equal(
    commandActivityAction(patchActivity, false, false, 'en'),
    'Edited',
  );
  assert.equal(toolActivityGroupSummary([patchActivity], 'zh'), '已编辑 3 个文件');
  assert.equal(toolActivityGroupSummary([patchActivity], 'en'), 'Edited 3 files');
});
