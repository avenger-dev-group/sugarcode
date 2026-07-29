// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConversationFileChangeActivity } from '@/shared/conversation';

import { FileChangeReview } from '../file-change-review';
import { toFileChangeReviewViewModel } from '../use-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const BEFORE_SHA256 = 'a'.repeat(64);
const AFTER_SHA256 = 'b'.repeat(64);
const DIFF =
  '--- a/notes.txt\n' +
  '+++ b/notes.txt\n' +
  '@@ -1,3 +1,3 @@\n' +
  ' one\n' +
  '-two\n' +
  '+second\n' +
  ' three\n';

const activity = (): ConversationFileChangeActivity => ({
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
    beforeBytes: 14,
    afterBytes: 17,
    newlineStyle: 'lf',
    finalNewline: true,
  },
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('FileChangeReview', () => {
  it('parses line numbers and renders an exact, collapsible durable diff', async () => {
    const review = toFileChangeReviewViewModel(
      'ready',
      'completed',
      {
        ...activity(),
        result: {
          id: 'item_result',
          status: 'completed',
          outcome: {
            type: 'success',
            path: 'notes.txt',
            beforeSha256: BEFORE_SHA256,
            afterSha256: AFTER_SHA256,
            beforeBytes: 14,
            afterBytes: 17,
          },
        },
      },
    );
    expect(review).toMatchObject({
      state: 'applied',
      change: {
        additions: 1,
        deletions: 1,
        hunks: [
          {
            lines: [
              { kind: 'context', oldLine: 1, newLine: 1, text: 'one' },
              { kind: 'deletion', oldLine: 2, newLine: null, text: 'two' },
              {
                kind: 'addition',
                oldLine: null,
                newLine: 2,
                text: 'second',
              },
              {
                kind: 'context',
                oldLine: 3,
                newLine: 3,
                text: 'three',
              },
            ],
          },
        ],
      },
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<FileChangeReview review={review} />);
    });

    expect(document.body.textContent).toContain('File change applied');
    expect(document.body.textContent).toContain('@@ -1,3 +1,3 @@');
    expect(document.body.textContent).toContain('+second');
    expect(document.body.textContent).toContain(BEFORE_SHA256);
    expect(
      document.querySelector(
        '[aria-label="File change applied: notes.txt"]',
      )?.className,
    ).toContain('max-w-[calc(100%-2.5rem)]');
    expect(
      document.querySelector(
        '[aria-label="Unified diff for notes.txt"]',
      )?.className,
    ).toContain('max-w-full');
    expect(
      document.querySelectorAll('button, a, input, textarea'),
    ).toHaveLength(1);

    const toggle = document.querySelector('button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).not.toContain('@@ -1,3 +1,3 @@');
    await act(async () => {
      root.unmount();
    });
  });

  it('distinguishes failed application from an interrupted unknown outcome', () => {
    expect(
      toFileChangeReviewViewModel('ready', 'completed', {
        ...activity(),
        result: {
          id: 'item_result',
          status: 'completed',
          outcome: { type: 'error', kind: 'conflict' },
        },
      }),
    ).toMatchObject({
      state: 'failed',
      errorKind: 'conflict',
    });
    expect(
      toFileChangeReviewViewModel(
        'ready',
        'interrupted',
        activity(),
      ).state,
    ).toBe('outcomeUnknown');
    expect(
      toFileChangeReviewViewModel('ready', 'interrupted', {
        id: 'item_call',
        callId: 'call_patch',
        path: 'notes.txt',
        callStatus: 'completed',
      }).state,
    ).toBe('interrupted');
  });
});
