import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalResponseCandidateIssue,
  normalizeFinalResponseCandidate,
} from '../../src/runtime/final-response-quality.ts';

test('strips a model-facing preamble from the user answer', () => {
  const normalized = normalizeFinalResponseCandidate(
    'Generated successfully. Now produce the final answer in Chinese.\n\n已生成三组结果。',
  );

  assert.equal(normalized.text, '已生成三组结果。');
  assert.equal(normalized.removedPrefix, true);
  assert.match(normalized.diagnostic ?? '', /model-facing instruction/u);
});

test('strips accumulated internal work narration from the user answer', () => {
  const normalized = normalizeFinalResponseCandidate(
    'The user asked for a project review. Let me inspect the tests. I need to summarize the result in the final answer.\n\n项目审查完成。',
  );

  assert.equal(normalized.text, '项目审查完成。');
  assert.equal(normalized.removedPrefix, true);
  assert.match(normalized.diagnostic ?? '', /internal work narration/u);
});

test('preserves suspicious output when no clean suffix can be isolated', () => {
  const value = 'Now produce the final answer in Chinese.';
  const normalized = normalizeFinalResponseCandidate(value);

  assert.equal(normalized.text, value);
  assert.equal(normalized.removedPrefix, false);
  assert.match(normalized.diagnostic ?? '', /model-facing instruction/u);
});

test('accepts concise answers with ordinary technical English', () => {
  assert.equal(
    finalResponseCandidateIssue(
      '审查完成。React 状态更新形成了循环；相关 TypeScript 测试均已通过。',
    ),
    undefined,
  );
  assert.equal(
    finalResponseCandidateIssue(
      'The parser recognizes `Now produce the final answer` as unsafe metadata.',
    ),
    undefined,
  );
});

test('accepts normal English prose that uses isolated planning vocabulary', () => {
  assert.equal(
    finalResponseCandidateIssue(
      'The user-facing workflow is now language-neutral. We need to preserve ordinary first-person prose, and the final answer may invite the reader to let me know if another example would help.',
    ),
    undefined,
  );
  assert.equal(
    finalResponseCandidateIssue(
      'I need to highlight one limitation: English summaries can be long, but they remain valid user-facing responses.',
    ),
    undefined,
  );
});

test('ignores model-instruction examples inside Markdown quotations', () => {
  assert.equal(
    finalResponseCandidateIssue(
      'The invalid provider output contained this line:\n\n> Now produce the final answer in English.\n\nThat quoted line is evidence, not an instruction to the model.',
    ),
    undefined,
  );
});
