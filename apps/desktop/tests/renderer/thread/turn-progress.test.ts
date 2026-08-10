import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeTurnOperationProgress,
  toActiveTurnProgress,
} from '../../../src/renderer/components/thread/turn-progress.ts';
import type { TurnViewModel } from '../../../src/renderer/components/thread/types.ts';

test('quiet active turns stay in a calm thinking state', () => {
  const progress = toActiveTurnProgress(
    '00000000-0001-7000-8000-000000000001',
    'inProgress',
  );

  assert.equal(progress.state, 'thinking');
  assert.equal(progress.label, '思考中');
  assert.equal(progress.detail, undefined);
});

test('active operation progress takes precedence over thinking', () => {
  const progress = toActiveTurnProgress(
    'turn_1',
    'inProgress',
    {
      state: 'waitingForApproval',
      label: '等待你确认文件修改',
      detail: 'Update src/example.ts',
    },
  );

  assert.equal(progress.state, 'waitingForApproval');
  assert.equal(progress.label, '等待你确认文件修改');
  assert.equal(progress.detail, 'Update src/example.ts');
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

test('active Skill activity uses a clear name without a dollar marker', () => {
  const turn = {
    id: 'turn_1',
    status: 'inProgress',
    verifiedFilePaths: [] as readonly string[],
    processLanguage: 'zh',
    messages: [] as const,
    activities: [
      {
        type: 'skill',
        activity: {
          id: 'skill_1',
          name: 'frontend-design',
          state: 'running',
        },
      },
    ],
    isError: false,
  } satisfies TurnViewModel;

  assert.deepEqual(activeTurnOperationProgress(turn), {
    state: 'runningTool',
    label: '正在应用 Skill',
    detail: 'frontend-design',
  });
});

test('progress labels distinguish stopping and unavailable ownership', () => {
  assert.equal(
    toActiveTurnProgress('turn_1', 'stopping').state,
    'stopping',
  );
  assert.equal(
    toActiveTurnProgress('turn_1', 'unavailable').state,
    'uncertain',
  );
});
