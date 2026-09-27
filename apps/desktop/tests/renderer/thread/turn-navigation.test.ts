import assert from 'node:assert/strict';
import test from 'node:test';

import type { TurnViewModel } from '../../../src/renderer/components/thread/types.ts';
import {
  shouldShowTurnNavigator,
  toTurnNavigationPreview,
} from '../../../src/renderer/components/thread/turn-navigation.ts';

const turn: TurnViewModel = {
  id: 'turn-1',
  status: 'completed',
  verifiedFilePaths: [],
  processLanguage: 'zh',
  messages: [
    {
      role: 'user',
      message: {
        id: 'user-1',
        text: '## 请帮我\n\n修复 **登录** 问题',
        references: [],
        attachments: [],
      },
    },
    {
      role: 'agent',
      message: {
        id: 'agent-1',
        text: '已经定位问题，并修复了会话过期的逻辑。',
        state: 'completed',
        verifiedFilePaths: [],
      },
    },
  ],
  isError: false,
};

test('the navigator appears starting with the fourth turn', () => {
  assert.equal(shouldShowTurnNavigator(3), false);
  assert.equal(shouldShowTurnNavigator(4), true);
});

test('turn previews include readable user and agent excerpts', () => {
  assert.deepEqual(toTurnNavigationPreview(turn, 1), {
    question: '请帮我 修复 登录 问题',
    answer: '已经定位问题，并修复了会话过期的逻辑。',
  });
});
