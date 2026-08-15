import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgentPreviewResponse } from '../../src/shared/preview-intent.ts';

test('terminal preview metadata becomes a validated Agent preview intent', () => {
  assert.deepEqual(
    parseAgentPreviewResponse(
      '官网已经完成。\n\n::preview{url="http://localhost:5173/landing?mode=demo"}',
    ),
    {
      text: '官网已经完成。',
      intent: { url: 'http://localhost:5173/landing?mode=demo' },
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
});
