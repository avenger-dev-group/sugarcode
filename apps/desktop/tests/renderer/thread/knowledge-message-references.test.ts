import assert from 'node:assert/strict';
import test from 'node:test';

import { knowledgeMessagePresentation } from '../../../src/renderer/components/thread/knowledge-message-references.ts';

test('an inherited stable knowledge reference is shown as a user-message capsule', () => {
  const presentation = knowledgeMessagePresentation({
    text: '电话是多少？',
    knowledgeReferences: [{
      knowledgeBaseId: `kb_${'1'.repeat(32)}`,
      name: 'AixvoLink 资料库',
    }],
  });
  assert.equal(presentation.text, '电话是多少？');
  assert.deepEqual(presentation.references, [{
    kind: 'knowledge',
    value: '@知识库`AixvoLink 资料库`',
    target: 'AixvoLink 资料库',
    start: 0,
    end: 19,
  }]);
});

test('an explicit knowledge reference is not duplicated by its stable metadata', () => {
  const presentation = knowledgeMessagePresentation({
    text: '@知识库产品规范 请查询',
    knowledgeReferences: [{
      knowledgeBaseId: `kb_${'1'.repeat(32)}`,
      name: '产品规范',
    }],
  });
  assert.equal(presentation.references.length, 1);
  assert.equal(presentation.references[0]?.value, '@知识库产品规范');
});
