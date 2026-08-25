import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandSuggestions,
  composerDisplaySegments,
  findComposerToken,
  replaceComposerToken,
  skillSuggestions,
} from '../../../src/renderer/components/composer/suggestions.ts';
import type { SkillSummary } from '../../../src/shared/skills.ts';

const skill = (
  name: string,
  description: string,
  idSuffix: string,
): SkillSummary => ({
  id: `skl_${idSuffix.repeat(64).slice(0, 64)}`,
  name,
  description,
  source: 'bundled',
  path: `内置/${name}/SKILL.md`,
  sha256: idSuffix.repeat(64).slice(0, 64),
  bytes: 128,
  enabled: true,
});

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
  assert.equal(
    findComposerToken('@https://www.figma.com/design/example', 37),
    null,
  );
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

test('Figma links and the aggregate application receive distinct display segments', () => {
  assert.deepEqual(
    composerDisplaySegments(
      '@https://www.figma.com/design/example?node-id=1-2\n$figma',
      null,
    ),
    [
      {
        kind: 'link',
        text: '@https://www.figma.com/design/example?node-id=1-2',
      },
      { kind: 'text', text: '\n' },
      { kind: 'application', text: '$figma' },
    ],
  );
});

test('Figma search presents an executable application before its related Skills', () => {
  const suggestions = skillSuggestions(
    [
      skill('figma-code-connect', '维护组件映射', 'a'),
      skill('review', '审查代码', 'b'),
      skill('figma', '连接 Figma Desktop', 'c'),
      skill('figma-design-to-code', '实现设计', 'd'),
    ],
    'figma',
  );

  assert.deepEqual(
    suggestions.map(({ kind, label, alias, insertion }) => ({
      kind,
      label,
      alias,
      insertion,
    })),
    [
      {
        kind: 'application',
        label: 'Figma',
        alias: '$figma',
        insertion: '$figma',
      },
      {
        kind: 'skill',
        label: 'Figma: Code Connect',
        alias: '$figma-code-connect',
        insertion: '$figma-code-connect',
      },
      {
        kind: 'skill',
        label: 'Figma: 设计转代码',
        alias: '$figma-design-to-code',
        insertion: '$figma-design-to-code',
      },
    ],
  );
});
