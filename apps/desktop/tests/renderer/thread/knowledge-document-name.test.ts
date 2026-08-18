import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKnowledgeDocumentFileName,
  isValidKnowledgeDocumentBaseName,
  stripKnowledgeDocumentExtension,
} from '../../../src/renderer/components/knowledge/knowledge-document-name.ts';

test('knowledge document names receive the selected extension automatically', () => {
  assert.equal(buildKnowledgeDocumentFileName('公司信息', 'md'), '公司信息.md');
  assert.equal(buildKnowledgeDocumentFileName('公司信息', 'txt'), '公司信息.txt');
});

test('pasted text and markdown extensions are not duplicated', () => {
  assert.equal(stripKnowledgeDocumentExtension('公司信息.md'), '公司信息');
  assert.equal(stripKnowledgeDocumentExtension('公司信息.TXT'), '公司信息');
  assert.equal(buildKnowledgeDocumentFileName('公司信息.md', 'txt'), '公司信息.txt');
});

test('knowledge document base names reject paths, whitespace, and oversized names', () => {
  assert.equal(isValidKnowledgeDocumentBaseName('公司信息', 'md'), true);
  assert.equal(isValidKnowledgeDocumentBaseName('../公司信息', 'md'), false);
  assert.equal(isValidKnowledgeDocumentBaseName(' 公司信息', 'txt'), false);
  assert.equal(isValidKnowledgeDocumentBaseName('a'.repeat(253), 'md'), false);
});
