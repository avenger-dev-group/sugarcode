import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectAgentMarkdownTokens,
  repairStreamingMarkdown,
} from '../../../src/renderer/components/agent/agent-markdown-parser.ts';
import {
  createAgentMarkdownFileDisplayLabels,
  toAgentMarkdownFileLink,
  toAgentMarkdownLinkLabel,
} from '../../../src/renderer/components/agent/agent-markdown-link.ts';

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

test('file link labels flatten nested inline code without visible backticks', () => {
  const projection = projectAgentMarkdownTokens(
    '[`src/components/data-table/utils.ts`](src/components/data-table/utils.ts)',
    false,
  );
  const paragraph = projection.tokens.find((token) => token.type === 'paragraph');
  assert.ok(paragraph && paragraph.type === 'paragraph');
  const link = paragraph.tokens.find((token) => token.type === 'link');
  assert.ok(link && link.type === 'link');

  const displayLabels = createAgentMarkdownFileDisplayLabels(
    projection.tokens,
    () => null,
  );
  assert.equal(
    toAgentMarkdownLinkLabel(link.tokens, link.text),
    'src/components/data-table/utils.ts',
  );
  assert.deepEqual(
    toAgentMarkdownFileLink(
      link.href,
      link.tokens,
      link.text,
      displayLabels,
    ),
    {
      path: 'src/components/data-table/utils.ts',
      label: 'utils.ts',
    },
  );
  assert.equal(
    toAgentMarkdownFileLink(
      'https://example.com/utils.ts',
      link.tokens,
      link.text,
    ),
    null,
  );
});

test('file links use the shortest unique suffix and preserve semantic labels', () => {
  const projection = projectAgentMarkdownTokens(
    [
      '[src/pages/call-record/use-store.ts](src/pages/call-record/use-store.ts)',
      '[src/pages/contacts/use-store.ts](src/pages/contacts/use-store.ts)',
      '[登录 Store](src/pages/login/use-store.ts)',
    ].join('、'),
    false,
  );
  const paragraph = projection.tokens.find((token) => token.type === 'paragraph');
  assert.ok(paragraph && paragraph.type === 'paragraph');
  const links = paragraph.tokens.filter((token) => token.type === 'link');
  const displayLabels = createAgentMarkdownFileDisplayLabels(
    projection.tokens,
    () => null,
  );

  assert.deepEqual(
    links.map((link) =>
      link.type === 'link'
        ? toAgentMarkdownFileLink(
            link.href,
            link.tokens,
            link.text,
            displayLabels,
          )?.label
        : null,
    ),
    ['call-record/use-store.ts', 'contacts/use-store.ts', '登录 Store'],
  );
});
