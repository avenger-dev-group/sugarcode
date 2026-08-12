import assert from 'node:assert/strict';
import test from 'node:test';

import { copyTextToClipboard } from '../../../src/renderer/components/message-actions/copy-text.ts';
import { highlightCode } from '../../../src/renderer/utils/syntax-highlighter.ts';

test('highlights supported fenced-code aliases and escapes source HTML', () => {
  const highlighted = highlightCode(
    'const element = <script>alert("unsafe")</script>;',
    'tsx',
  );

  assert.ok(highlighted);
  assert.match(highlighted, /hljs-keyword/u);
  assert.doesNotMatch(highlighted, /<script>/u);
  assert.match(highlighted, /&lt;/u);
  assert.match(highlighted, /script/u);
});

test('highlights PHP, Go, Java, C#, C, and C++ fences', () => {
  const fixtures = [
    ['php', '<?php function answer(): int { return 42; }'],
    ['go', 'package main\nfunc main() { println(42) }'],
    ['java', 'class Main { static int answer() { return 42; } }'],
    ['c#', 'class Main { static int Answer() => 42; }'],
    ['c', 'int answer(void) { return 42; }'],
    ['c++', 'constexpr int answer() { return 42; }'],
  ] as const;

  for (const [language, code] of fixtures) {
    const highlighted = highlightCode(code, language);
    assert.ok(highlighted, `${language} should be highlighted`);
    assert.match(highlighted, /hljs-/u, `${language} should emit syntax tokens`);
  }
});

test('falls back to plain rendering for unknown languages', () => {
  assert.equal(highlightCode('plain text', 'not-a-language'), null);
  assert.equal(highlightCode('x'.repeat(256 * 1024 + 1), 'typescript'), null);
});

test('copies the exact code text through the provided clipboard boundary', async () => {
  let copied = '';

  await copyTextToClipboard('const value = 1;\n', {
    writeText: (text) => {
      copied = text;
      return Promise.resolve();
    },
  });

  assert.equal(copied, 'const value = 1;\n');
});

test('surfaces clipboard rejection for copy-failure feedback', async () => {
  await assert.rejects(
    copyTextToClipboard('copy me', {
      writeText: () => Promise.reject(new Error('clipboard denied')),
    }),
    /clipboard denied/u,
  );
});
