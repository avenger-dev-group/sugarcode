import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgentPreviewResponse } from '../../src/shared/preview-intent.ts';

test('terminal artifact metadata becomes a validated Agent preview intent', () => {
  assert.deepEqual(
    parseAgentPreviewResponse(
      '官网已经完成。\n\n::preview{path="dist/index.html"}',
    ),
    {
      text: '官网已经完成。',
      intent: { kind: 'artifact', path: 'dist/index.html' },
    },
  );
});

test('terminal video metadata becomes a validated Agent preview intent', () => {
  assert.deepEqual(
    parseAgentPreviewResponse(
      '视频已经完成。\n\n::preview{path="renders/final.mp4"}',
    ),
    {
      text: '视频已经完成。',
      intent: { kind: 'artifact', path: 'renders/final.mp4' },
    },
  );
});

test('a delivered video link becomes a fallback preview intent when metadata is omitted', () => {
  const source =
    '视频已经完成：[成片](renders/bug-fixed.mp4)，可以直接播放。';
  assert.deepEqual(parseAgentPreviewResponse(source), {
    text: source,
    intent: { kind: 'artifact', path: 'renders/bug-fixed.mp4' },
  });
});

test('video link fallback rejects external and escaping paths', () => {
  for (const source of [
    '[外部视频](https://example.com/final.mp4)',
    '[越界视频](../renders/final.mp4)',
  ]) {
    assert.deepEqual(parseAgentPreviewResponse(source), {
      text: source,
      intent: null,
    });
  }
});

test('legacy local URL metadata remains readable for existing conversations', () => {
  assert.deepEqual(
    parseAgentPreviewResponse(
      '官网已经完成。\n\n::preview{url="http://localhost:5173/landing?mode=demo"}',
    ),
    {
      text: '官网已经完成。',
      intent: {
        kind: 'url',
        url: 'http://localhost:5173/landing?mode=demo',
      },
    },
  );
});

test('terminal Draw.io metadata becomes a validated diagram intent', () => {
  assert.deepEqual(
    parseAgentPreviewResponse(
      '流程图已经生成。\n\n::draw{path="diagrams/leave-approval.drawio"}',
    ),
    {
      text: '流程图已经生成。',
      intent: { kind: 'drawio', path: 'diagrams/leave-approval.drawio' },
    },
  );
});

test('preview metadata is ignored unless it is the final response line', () => {
  const source = [
    '::preview{url="http://localhost:5173/"}',
    '',
    'This remains ordinary response text.',
  ].join('\n');

  assert.deepEqual(parseAgentPreviewResponse(source), {
    text: source,
    intent: null,
  });
});

test('unsafe or incomplete preview metadata stays hidden without creating an intent', () => {
  assert.deepEqual(
    parseAgentPreviewResponse(
      'Done.\n::preview{url="https://example.com/"}',
    ),
    { text: 'Done.', intent: null },
  );
  assert.deepEqual(
    parseAgentPreviewResponse('Done.\n::preview{url="http://localhost:'),
    { text: 'Done.', intent: null },
  );
  assert.deepEqual(
    parseAgentPreviewResponse('Done.\n::preview{path="../index.html"}'),
    { text: 'Done.', intent: null },
  );
  assert.deepEqual(
    parseAgentPreviewResponse('Done.\n::draw{path="../diagram.drawio"}'),
    { text: 'Done.', intent: null },
  );
});
