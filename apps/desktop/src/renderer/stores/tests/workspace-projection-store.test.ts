import { beforeEach, describe, expect, it } from 'vitest';

import {
  acceptWorkspaceSnapshot,
  workspaceProjectionStore,
} from '../workspace-projection-store';

beforeEach(() => {
  workspaceProjectionStore.setState({
    snapshot: {
      revision: 0,
      generation: 0,
      status: 'unselected',
    },
    sourceRevision: -1,
    loadError: null,
  });
});

describe('workspaceProjectionStore', () => {
  it('keeps the newest Main-owned snapshot when initial loading races an event', () => {
    acceptWorkspaceSnapshot({
      revision: 4,
      generation: 2,
      status: 'ready',
      kind: 'chat',
      name: '聊天文件',
      chatThreadIds: ['thr_0000000000000002'],
    });
    acceptWorkspaceSnapshot({
      revision: 3,
      generation: 1,
      status: 'selecting',
      kind: 'project',
      name: 'sugarcode',
      projectThreadIds: ['thr_0000000000000001'],
    });

    expect(workspaceProjectionStore.getState()).toMatchObject({
      sourceRevision: 4,
      snapshot: {
        revision: 4,
        generation: 2,
        status: 'ready',
        kind: 'chat',
        chatThreadIds: ['thr_0000000000000002'],
      },
    });
  });
});
