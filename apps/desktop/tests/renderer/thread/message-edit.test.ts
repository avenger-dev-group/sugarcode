import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasCopyableUserText,
  isSameEditableMessageTarget,
  latestEditableMessageTarget,
} from '../../../src/renderer/components/thread/message-edit.ts';
import type {
  TranscriptMessageViewModel,
  TurnViewModel,
} from '../../../src/renderer/components/thread/types.ts';

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

test('copy actions require visible user text', () => {
  assert.equal(hasCopyableUserText('  \n\t'), false);
  assert.equal(hasCopyableUserText('  可见消息  '), true);
});

test('only the latest terminal user Turn can be edited', () => {
  const turns = [turn('first', 'completed'), turn('latest', 'interrupted')];
  assert.deepEqual(
    latestEditableMessageTarget(turns, 'ready', false),
    { turnId: 'latest', messageId: 'latest:user' },
  );
  assert.equal(latestEditableMessageTarget(turns, 'inProgress', false), null);
  assert.equal(latestEditableMessageTarget(turns, 'ready', true), null);
});

test('a trailing maintenance Turn prevents editing the previous user Turn', () => {
  assert.equal(
    latestEditableMessageTarget(
      [turn('user', 'completed'), turn('compact', 'completed', false)],
      'ready',
      false,
    ),
    null,
  );
});

test('a Goal objective is visible but cannot be revised as an ordinary message', () => {
  assert.equal(
    latestEditableMessageTarget(
      [{ ...turn('goal', 'completed'), origin: 'goal' }],
      'ready',
      false,
    ),
    null,
  );
});

test('editing targets only the originating user message in the latest Turn', () => {
  const latest = turn('latest', 'failed');
  const secondUserMessage: TranscriptMessageViewModel = {
    role: 'user' as const,
    message: {
      id: 'latest:follow-up',
      text: '补充回答',
      references: [],
      attachments: [],
    },
  };
  assert.deepEqual(
    latestEditableMessageTarget(
      [{ ...latest, messages: [...latest.messages, secondUserMessage] }],
      'ready',
      false,
    ),
    { turnId: 'latest', messageId: 'latest:user' },
  );
  assert.equal(
    isSameEditableMessageTarget(
      { turnId: 'latest', messageId: 'latest:user' },
      { turnId: 'latest', messageId: 'latest:follow-up' },
    ),
    false,
  );
});
