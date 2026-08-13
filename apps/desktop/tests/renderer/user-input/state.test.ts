import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasHorizontalOverflow,
  initialUserInputDraftState,
  nextUserInputQuestionIndex,
  orderedUserInputDecisions,
  shouldConfirmCustomAnswer,
} from '../../../src/renderer/components/user-input/state.ts';
import type { UserInputAnswer } from '../../../src/renderer/components/user-input/types.ts';

const optionDecision = (
  questionId: string,
  answer: string,
): UserInputAnswer => ({
  questionId,
  kind: 'answered',
  source: 'option',
  answer,
});

test('user-input draft state starts without leaking a previous request', () => {
  assert.deepEqual(initialUserInputDraftState(), {
    questionIndex: 0,
    decisions: {},
    customAnswers: {},
    submitting: false,
    error: null,
  });
});

test('answering advances and wraps to an unresolved earlier question', () => {
  const questionIds = ['scope', 'rollout', 'compatibility'];
  assert.equal(
    nextUserInputQuestionIndex(0, questionIds, {
      scope: optionDecision('scope', '完整链路（推荐）'),
    }),
    1,
  );
  assert.equal(
    nextUserInputQuestionIndex(2, questionIds, {
      rollout: { questionId: 'rollout', kind: 'skipped' },
      compatibility: optionDecision('compatibility', '保持兼容'),
    }),
    0,
  );
  assert.equal(
    nextUserInputQuestionIndex(2, questionIds, {
      scope: optionDecision('scope', '完整链路（推荐）'),
      rollout: { questionId: 'rollout', kind: 'skipped' },
      compatibility: optionDecision('compatibility', '保持兼容'),
    }),
    null,
  );
});

test('partial cancellation preserves decisions in question order', () => {
  assert.deepEqual(
    orderedUserInputDecisions(
      ['scope', 'rollout', 'compatibility'],
      {
        compatibility: {
          questionId: 'compatibility',
          kind: 'answered',
          source: 'custom',
          answer: '仅兼容当前版本',
        },
        scope: optionDecision('scope', '完整链路（推荐）'),
      },
    ),
    [
      optionDecision('scope', '完整链路（推荐）'),
      {
        questionId: 'compatibility',
        kind: 'answered',
        source: 'custom',
        answer: '仅兼容当前版本',
      },
    ],
  );
});

test('option tooltip appears only when text is horizontally clipped', () => {
  assert.equal(hasHorizontalOverflow(481, 320), true);
  assert.equal(hasHorizontalOverflow(321, 320), false);
  assert.equal(hasHorizontalOverflow(320, 320), false);
});

test('custom answer Enter ignores active IME composition', () => {
  assert.equal(shouldConfirmCustomAnswer('Enter', true, false, 13), true);
  assert.equal(shouldConfirmCustomAnswer('Enter', true, true, 13), false);
  assert.equal(shouldConfirmCustomAnswer('Enter', true, false, 229), false);
  assert.equal(shouldConfirmCustomAnswer('Enter', false, false, 13), false);
  assert.equal(shouldConfirmCustomAnswer('a', true, false, 65), false);
});
