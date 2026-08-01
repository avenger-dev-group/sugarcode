import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveThreadTitle,
  isThreadTitle,
} from '../../../../src/main/app-server/conversation/thread-title.ts';

test('thread title is derived from normalized prompt content', () => {
  assert.equal(
    deriveThreadTitle('  优化  项目中的\n第一个问题  '),
    '优化 项目中的 第一个问题',
  );
});

test('generic greetings wait for a task-bearing prompt', () => {
  assert.equal(deriveThreadTitle('你好！'), undefined);
  assert.equal(deriveThreadTitle(' Hello '), undefined);
});

test('thread title is unicode-safe and bounded', () => {
  assert.equal(deriveThreadTitle('改'.repeat(49)), `${'改'.repeat(48)}…`);
});

test('attachment-only prompts use the file name', () => {
  assert.equal(deriveThreadTitle('', '需求说明.pdf'), '处理 需求说明.pdf');
  assert.equal(
    deriveThreadTitle('', '文'.repeat(60)),
    `${`处理 ${'文'.repeat(45)}`}…`,
  );
});

test('control characters are sanitized in derived titles and rejected at protocol boundaries', () => {
  assert.equal(deriveThreadTitle('修复\u0000登录'), '修复 登录');
  assert.equal(isThreadTitle('修复登录'), true);
  assert.equal(isThreadTitle('修复\u0000登录'), false);
});
