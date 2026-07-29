import { describe, expect, it } from 'vitest';

import {
  parseThreadResumeResponse,
  type ResumeSnapshot,
} from '../protocol';
import { recoverConversation } from '../recovery';

const BEFORE_SHA256 = 'a'.repeat(64);
const AFTER_SHA256 = 'b'.repeat(64);
const DIFF =
  '--- a/notes.txt\n' +
  '+++ b/notes.txt\n' +
  '@@ -1,1 +1,1 @@\n' +
  '-old\n' +
  '+new\n';

const durableItems = () => {
  const content = JSON.stringify({
    kind: 'update',
    path: 'notes.txt',
    beforeSha256: BEFORE_SHA256,
    afterSha256: AFTER_SHA256,
    beforeBytes: 4,
    afterBytes: 4,
  });
  return [
    {
      type: 'toolCall',
      id: 'item_call',
      callId: 'call_patch',
      name: 'workspace/apply-patch',
      path: 'notes.txt',
    },
    {
      type: 'fileChange',
      id: 'item_change',
      callId: 'call_patch',
      path: 'notes.txt',
      kind: 'update',
      diff: DIFF,
      beforeSha256: BEFORE_SHA256,
      afterSha256: AFTER_SHA256,
      beforeBytes: 4,
      afterBytes: 4,
      newlineStyle: 'lf',
      finalNewline: true,
    },
    {
      type: 'toolResult',
      id: 'item_result',
      callId: 'call_patch',
      name: 'workspace/apply-patch',
      result: {
        type: 'success',
        content,
        bytes: new TextEncoder().encode(content).byteLength,
      },
    },
  ];
};

const resume = (
  status: 'completed' | 'interrupted',
  items: readonly unknown[],
): ResumeSnapshot =>
  parseThreadResumeResponse({
    thread: { id: 'thr_file_change' },
    turns: [{ id: 'turn_file_change', status, items }],
  });

describe('workspace/apply-patch conversation recovery', () => {
  it('recovers the exact proposal and matched success proof', () => {
    const recovered = recoverConversation(
      'thr_file_change',
      resume('completed', durableItems()),
    );

    expect(recovered.turns[0]?.fileChange).toEqual({
      id: 'item_call',
      callId: 'call_patch',
      path: 'notes.txt',
      callStatus: 'completed',
      change: {
        id: 'item_change',
        status: 'completed',
        path: 'notes.txt',
        kind: 'update',
        diff: DIFF,
        beforeSha256: BEFORE_SHA256,
        afterSha256: AFTER_SHA256,
        beforeBytes: 4,
        afterBytes: 4,
        newlineStyle: 'lf',
        finalNewline: true,
      },
      result: {
        id: 'item_result',
        status: 'completed',
        outcome: {
          type: 'success',
          path: 'notes.txt',
          beforeSha256: BEFORE_SHA256,
          afterSha256: AFTER_SHA256,
          beforeBytes: 4,
          afterBytes: 4,
        },
      },
    });
  });

  it('preserves an interrupted proposal without fabricating an outcome', () => {
    const recovered = recoverConversation(
      'thr_file_change',
      resume('interrupted', durableItems().slice(0, 2)),
    );

    expect(recovered.turns[0]?.fileChange?.change?.status).toBe(
      'completed',
    );
    expect(recovered.turns[0]?.fileChange?.result).toBeUndefined();
  });

  it('rejects a completed Turn without a result and mismatched success proof', () => {
    expect(() =>
      recoverConversation(
        'thr_file_change',
        resume('completed', durableItems().slice(0, 2)),
      ),
    ).toThrow('without a result');

    const items = durableItems();
    const result = items[2] as {
      result: { content: string; bytes: number };
    };
    const content = JSON.stringify({
      ...JSON.parse(result.result.content),
      afterBytes: 5,
    });
    expect(() =>
      recoverConversation(
        'thr_file_change',
        resume('completed', [
          ...items.slice(0, 2),
          {
            ...items[2],
            result: {
              ...result.result,
              content,
              bytes: new TextEncoder().encode(content).byteLength,
            },
          },
        ]),
      ),
    ).toThrow('unmatched workspace/apply-patch result');
  });
});
