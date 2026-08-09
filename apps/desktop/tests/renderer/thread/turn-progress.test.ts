import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeTurnOperationProgress,
  formatWaitDuration,
  MODEL_WAIT_NOTICE_SECONDS,
  toActiveTurnProgress,
} from '../../../src/renderer/components/thread/turn-progress.ts';
import type { TurnViewModel } from '../../../src/renderer/components/thread/types.ts';

test('quiet active turns identify the model wait and its bounded deadline', () => {
  const progress = toActiveTurnProgress(
    '00000000-0001-7000-8000-000000000001',
    'metis-coder',
    'inProgress',
    MODEL_WAIT_NOTICE_SECONDS,
  );

  assert.equal(progress.state, 'waitingForModel');
  assert.match(progress.label, /metis-coder/);
  assert.equal(progress.elapsedLabel, '已等待 15s');
  assert.match(progress.detail ?? '', /最长约 5 分钟/);
  assert.match(progress.detail ?? '', /超时会自动结束/);
});

test('active operation progress takes precedence over a quiet model wait', () => {
  const progress = toActiveTurnProgress(
    'turn_1',
    'fixture-model',
    'inProgress',
    60,
    {
      state: 'waitingForApproval',
      label: '等待你确认文件修改',
      detail: 'Update src/example.ts',
    },
  );

  assert.equal(progress.state, 'waitingForApproval');
  assert.equal(progress.label, '等待你确认文件修改');
  assert.equal(progress.detail, 'Update src/example.ts');
  assert.equal(progress.elapsedLabel, undefined);
});

test('active Turn activity identifies approval and tool stages', () => {
  const turn = {
    id: 'turn_1',
    status: 'inProgress',
    verifiedFilePaths: [] as readonly string[],
    processLanguage: 'zh',
    messages: [] as const,
    activities: [
      {
        type: 'workspaceSearch',
        activity: {
          id: 'search_1',
          path: 'src',
          query: 'workspace_apply_patch',
          state: 'running',
        },
      },
      {
        type: 'commandApproval',
        activity: {
          id: 'approval_1',
          operationKind: 'workspacePatch',
          command: 'Update src/example.ts',
          argumentCount: 0,
          state: 'awaiting',
        },
      },
    ],
    isError: false,
  } satisfies TurnViewModel;

  assert.deepEqual(activeTurnOperationProgress(turn), {
    state: 'waitingForApproval',
    label: '等待你确认文件修改',
    detail: 'Update src/example.ts',
  });
  assert.doesNotMatch(
    activeTurnOperationProgress(turn)?.detail ?? '',
    /workspace_apply_patch/u,
  );
});

test('progress labels distinguish stopping and unavailable ownership', () => {
  assert.equal(
    toActiveTurnProgress('turn_1', undefined, 'stopping', 100).state,
    'stopping',
  );
  assert.equal(
    toActiveTurnProgress('turn_1', undefined, 'unavailable', 100).state,
    'uncertain',
  );
});

test('wait duration remains compact', () => {
  assert.equal(formatWaitDuration(12), '12s');
  assert.equal(formatWaitDuration(60), '1m');
  assert.equal(formatWaitDuration(125), '2m 5s');
});
