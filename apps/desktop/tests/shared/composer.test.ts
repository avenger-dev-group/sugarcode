import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findComposerReferences,
  parseComposerSubmission,
} from '../../src/shared/composer.ts';

test('composer submission separates selected controls from the visible message', () => {
  const submission = parseComposerSubmission(
    '$estimate\n@.gitignore\n/fix\n\n目前选择了几个能力？先不修改',
  );

  assert.equal(submission.text, '目前选择了几个能力？先不修改');
  assert.deepEqual(
    submission.references.map(({ kind, value, target }) => ({
      kind,
      value,
      target,
    })),
    [
      { kind: 'skill', value: '$estimate', target: 'estimate' },
      { kind: 'file', value: '@.gitignore', target: '.gitignore' },
      { kind: 'command', value: '/fix', target: 'fix' },
    ],
  );
});

test('composer references require token boundaries and commands require line-leading placement', () => {
  assert.deepEqual(findComposerReferences('email@example.com and src/fix'), []);
  assert.deepEqual(
    findComposerReferences('说明文字\n  /review\nuse @`docs/my file.md`'),
    [
      {
        kind: 'command',
        value: '/review',
        target: 'review',
        start: 7,
        end: 14,
      },
      {
        kind: 'file',
        value: '@`docs/my file.md`',
        target: 'docs/my file.md',
        start: 19,
        end: 37,
      },
    ],
  );
});

test('/compact is parsed as maintenance metadata with an optional focus', () => {
  const submission = parseComposerSubmission('/compact 保留数据库迁移决策');
  assert.equal(submission.text.trim(), '保留数据库迁移决策');
  assert.deepEqual(submission.references.map(({ kind, target }) => ({
    kind,
    target,
  })), [{ kind: 'command', target: 'compact' }]);
});

test('/draw is parsed as an executable diagram command', () => {
  const submission = parseComposerSubmission('/draw 画员工请假审批流程图');
  assert.equal(submission.text.trim(), '画员工请假审批流程图');
  assert.deepEqual(submission.references.map(({ kind, target }) => ({
    kind,
    target,
  })), [{ kind: 'command', target: 'draw' }]);
});
