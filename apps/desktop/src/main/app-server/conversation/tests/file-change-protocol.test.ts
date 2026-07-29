import { describe, expect, it } from 'vitest';

import { parseWorkspacePatchItem } from '../file-change-protocol';

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

const proposal = () => ({
  type: 'fileChange',
  id: 'item_change',
  callId: 'call_patch',
  path: 'notes.txt',
  kind: 'update',
  diff: DIFF,
  beforeSha256: BEFORE_SHA256,
  afterSha256: AFTER_SHA256,
  beforeBytes: 14,
  afterBytes: 17,
  newlineStyle: 'lf',
  finalNewline: true,
});

describe('workspace/apply-patch conversation protocol', () => {
  it('parses the durable call, review proposal, and bounded success result', () => {
    expect(
      parseWorkspacePatchItem({
        type: 'toolCall',
        id: 'item_call',
        callId: 'call_patch',
        name: 'workspace/apply-patch',
        path: 'notes.txt',
      }),
    ).toEqual({
      type: 'workspacePatchCall',
      id: 'item_call',
      callId: 'call_patch',
      path: 'notes.txt',
    });
    expect(parseWorkspacePatchItem(proposal())).toMatchObject({
      type: 'workspacePatchChange',
      id: 'item_change',
      callId: 'call_patch',
      path: 'notes.txt',
      status: 'inProgress',
    });

    const content = JSON.stringify({
      kind: 'update',
      path: 'notes.txt',
      beforeSha256: BEFORE_SHA256,
      afterSha256: AFTER_SHA256,
      beforeBytes: 14,
      afterBytes: 17,
    });
    expect(
      parseWorkspacePatchItem({
        type: 'toolResult',
        id: 'item_result',
        callId: 'call_patch',
        name: 'workspace/apply-patch',
        result: {
          type: 'success',
          content,
          bytes: new TextEncoder().encode(content).byteLength,
        },
      }),
    ).toEqual({
      type: 'workspacePatchResult',
      id: 'item_result',
      callId: 'call_patch',
      outcome: {
        type: 'success',
        path: 'notes.txt',
        beforeSha256: BEFORE_SHA256,
        afterSha256: AFTER_SHA256,
        beforeBytes: 14,
        afterBytes: 17,
      },
    });
  });

  it('rejects malformed or over-budget review proposals', () => {
    expect(() =>
      parseWorkspacePatchItem({
        ...proposal(),
        diff: DIFF.replace('@@ -1,3 +1,3 @@', '@@ -1 +1 @@'),
      }),
    ).toThrow('Invalid FileChange Item');
    expect(() =>
      parseWorkspacePatchItem({
        ...proposal(),
        path: '../notes.txt',
      }),
    ).toThrow('Invalid FileChange Item');
    expect(() =>
      parseWorkspacePatchItem({
        ...proposal(),
        beforeBytes: 256 * 1024 + 1,
      }),
    ).toThrow('Invalid FileChange Item');
  });

  it('rejects success metadata or byte counts that are not trustworthy', () => {
    const content = JSON.stringify({
      kind: 'update',
      path: 'notes.txt',
      beforeSha256: BEFORE_SHA256,
      afterSha256: AFTER_SHA256,
      beforeBytes: 14,
      afterBytes: 17,
    });
    expect(() =>
      parseWorkspacePatchItem({
        type: 'toolResult',
        id: 'item_result',
        callId: 'call_patch',
        name: 'workspace/apply-patch',
        result: {
          type: 'success',
          content,
          bytes: 1,
        },
      }),
    ).toThrow('Invalid workspace/apply-patch ToolResult outcome');
    expect(() =>
      parseWorkspacePatchItem({
        type: 'toolResult',
        id: 'item_result',
        callId: 'call_patch',
        name: 'workspace/apply-patch',
        result: {
          type: 'success',
          content: JSON.stringify({
            ...JSON.parse(content),
            extra: true,
          }),
          bytes: 1,
        },
      }),
    ).toThrow();
  });
});
