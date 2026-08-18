import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandSuggestions,
  composerDisplaySegments,
  findComposerToken,
  replaceComposerToken,
} from '../../../src/renderer/components/composer/suggestions.ts';

test('composer detects commands only at the start and mentions at token boundaries', () => {
  assert.deepEqual(findComposerToken('/rev', 4), {
    trigger: '/',
    start: 0,
    end: 4,
    query: 'rev',
  });
  assert.equal(findComposerToken('please /rev', 11), null);
  assert.deepEqual(findComposerToken('use $front', 10), {
    trigger: '$',
    start: 4,
    end: 10,
    query: 'front',
  });
  assert.deepEqual(findComposerToken('check @src/app', 14), {
    trigger: '@',
    start: 6,
    end: 14,
    query: 'src/app',
  });
  const multiline = '@components.json\n$estimate\n/';
  assert.deepEqual(findComposerToken(multiline, multiline.length), {
    trigger: '/',
    start: multiline.length - 1,
    end: multiline.length,
    query: '',
  });
  assert.equal(findComposerToken('first line\nplease /rev', 22), null);
});

test('command filtering and insertion preserve text around the caret', () => {
  assert.deepEqual(commandSuggestions('rev').map((entry) => entry.alias), [
    '/review',
  ]);
  assert.deepEqual(commandSuggestions('图表').map((entry) => entry.alias), [
    '/draw',
  ]);
  const token = findComposerToken('check $front later', 12);
  assert.ok(token);
  assert.deepEqual(replaceComposerToken('check $front later', token, '$frontend-design'), {
    value: 'check $frontend-design later',
    caret: 22,
  });
});

test('completed commands, Skills, and files become reference display segments', () => {
  assert.deepEqual(
    composerDisplaySegments(
      '/review use $frontend-design and @apps/desktop/src/main.ts',
      null,
    ),
    [
      { kind: 'command', text: '/review' },
      { kind: 'text', text: ' use ' },
      { kind: 'skill', text: '$frontend-design' },
      { kind: 'text', text: ' and ' },
      { kind: 'file', text: '@apps/desktop/src/main.ts' },
    ],
  );
  assert.deepEqual(
    composerDisplaySegments('@components.json\n$estimate\n/review', null),
    [
      { kind: 'file', text: '@components.json' },
      { kind: 'text', text: '\n' },
      { kind: 'skill', text: '$estimate' },
      { kind: 'text', text: '\n' },
      { kind: 'command', text: '/review' },
    ],
  );
  assert.deepEqual(
    composerDisplaySegments('@知识库产品规范 请检查', null),
    [
      { kind: 'knowledge', text: '@知识库产品规范' },
      { kind: 'text', text: ' 请检查' },
    ],
  );
});

test('the token being edited stays regular text until selection completes', () => {
  assert.deepEqual(
    composerDisplaySegments('$front', {
      trigger: '$',
      start: 0,
      end: 6,
      query: 'front',
    }),
    [{ kind: 'text', text: '$front' }],
  );
});
