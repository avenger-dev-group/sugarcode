import assert from 'node:assert/strict';
import test from 'node:test';

import { splitKnowledgeCitationText } from '../../../src/renderer/components/agent/knowledge-citation-text.ts';

test('knowledge citation text links only citations backed by durable search results', () => {
  assert.deepEqual(
    splitKnowledgeCitationText('结论 [K1]，未知 [K2]。', new Set(['K1'])),
    [
      { type: 'text', value: '结论 ' },
      { type: 'citation', label: 'K1' },
      { type: 'text', value: '，未知 [K2]。' },
    ],
  );
});

test('knowledge citation text preserves ordinary bracket text and out-of-range labels', () => {
  assert.deepEqual(
    splitKnowledgeCitationText('[K9] [K1] ordinary', new Set()),
    [{ type: 'text', value: '[K9] [K1] ordinary' }],
  );
});
