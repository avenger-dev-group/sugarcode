import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectAgentMarkdownTokens,
  repairStreamingMarkdown,
} from '../../../src/renderer/components/agent/agent-markdown-parser.ts';

test('projects GFM task lists and tables for the Codex-style renderer', () => {
  const source = [
    '- [x] Complete',
    '- [ ] Pending',
    '',
    '| Name | State |',
    '| --- | --- |',
    '| Parser | Ready |',
  ].join('\n');
  const projection = projectAgentMarkdownTokens(source, false);
  const list = projection.tokens.find((token) => token.type === 'list');
  const table = projection.tokens.find((token) => token.type === 'table');

  assert.ok(list && list.type === 'list');
  assert.equal(list.items[0]?.task, true);
  assert.equal(list.items[0]?.checked, true);
  assert.equal(list.items[1]?.checked, false);
  assert.ok(table && table.type === 'table');
  assert.equal(table.header.length, 2);
  assert.equal(table.rows.length, 1);
});

test('repairs an open streaming code fence without mutating its source', () => {
  const source = '```ts\nconst value = 1;';

  assert.equal(repairStreamingMarkdown(source), `${source}\n\`\`\``);

  const projection = projectAgentMarkdownTokens(source, true);
  const code = projection.tokens.find((token) => token.type === 'code');
  assert.ok(code && code.type === 'code');
  assert.equal(code.lang, 'ts');
  assert.equal(code.text, 'const value = 1;');
  assert.equal(projection.cache.prefixSource, '');
});
