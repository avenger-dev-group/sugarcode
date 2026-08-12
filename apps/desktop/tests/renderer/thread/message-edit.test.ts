import assert from 'node:assert/strict';
import test from 'node:test';

import { latestEditableTurnId } from '../../../src/renderer/components/thread/message-edit.ts';
import type { TurnViewModel } from '../../../src/renderer/components/thread/types.ts';

const turn = (
  id: string,
  status: TurnViewModel['status'],
  hasUserMessage = true,
): TurnViewModel => ({
  id,
  status,
  verifiedFilePaths: [],
  processLanguage: 'zh',
  messages: hasUserMessage
    ? [{
        role: 'user',
        message: {
          id: `${id}:user`,
          text: '消息',
          references: [],
          attachments: [],
        },
      }]
    : [],
  isError: false,
});

test('only the latest terminal user Turn can be edited', () => {
  const turns = [turn('first', 'completed'), turn('latest', 'interrupted')];
  assert.equal(latestEditableTurnId(turns, 'ready', false), 'latest');
  assert.equal(latestEditableTurnId(turns, 'inProgress', false), null);
  assert.equal(latestEditableTurnId(turns, 'ready', true), null);
});

test('a trailing maintenance Turn prevents editing the previous user Turn', () => {
  assert.equal(
    latestEditableTurnId(
      [turn('user', 'completed'), turn('compact', 'completed', false)],
      'ready',
      false,
    ),
    null,
  );
});
