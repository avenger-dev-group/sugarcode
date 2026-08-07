import assert from 'node:assert/strict';
import test from 'node:test';

import { toolActivityGroupSummary } from '../../../src/renderer/components/thread/tool-activity-copy.ts';
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
