import { describe, expect, it } from 'vitest';

import {
  isWorkspaceChatRequest,
  isWorkspaceInspectRequest,
  isWorkspaceListRequest,
  isWorkspaceStateSnapshot,
} from '../workspace';

describe('workspace boundary validation', () => {
  it('accepts a redacted state and safe relative paths', () => {
    expect(
      isWorkspaceStateSnapshot({
        revision: 2,
        generation: 1,
        status: 'ready',
        kind: 'chat',
        name: 'sugarcode',
        projectName: 'demo',
        projectThreadIds: [],
        chatThreadIds: ['thr_0000000000000001'],
      }),
    ).toBe(true);
    expect(
      isWorkspaceChatRequest({
        threadId: 'thr_0000000000000001',
      }),
    ).toBe(true);
    expect(isWorkspaceListRequest({ generation: 1, path: '' })).toBe(true);
    expect(
      isWorkspaceInspectRequest({
        generation: 1,
        path: 'src/main.rs',
      }),
    ).toBe(true);
  });

  it('rejects absolute, escaping, malformed, and extended requests', () => {
    for (const path of ['/etc/passwd', '../secret', 'src//main.rs']) {
      expect(
        isWorkspaceInspectRequest({ generation: 1, path }),
      ).toBe(false);
    }
    expect(
      isWorkspaceListRequest({
        generation: 1,
        path: '',
        absolutePath: '/private/project',
      }),
    ).toBe(false);
    expect(
      isWorkspaceChatRequest({
        threadId: '../../private/project',
      }),
    ).toBe(false);
    expect(
      isWorkspaceStateSnapshot({
        revision: 2,
        generation: 1,
        status: 'ready',
        kind: 'chat',
        name: '聊天文件',
        chatThreadIds: ['thr_safe'],
        path: '/Users/example/Documents/SugarCode',
      }),
    ).toBe(false);
  });
});
