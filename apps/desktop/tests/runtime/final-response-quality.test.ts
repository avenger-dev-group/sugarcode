import assert from 'node:assert/strict';
import test from 'node:test';

import { finalResponseCandidateIssue } from '../../src/runtime/final-response-quality.ts';

test('rejects model-facing instructions prepended to a user answer', () => {
  const issue = finalResponseCandidateIssue(
    'Generated successfully. Now produce the final answer in Chinese.\n\n已生成三组结果。',
  );

  assert.match(issue ?? '', /model-facing instruction/u);
});

test('rejects accumulated internal work narration in a final candidate', () => {
  const issue = finalResponseCandidateIssue(
    'The user asked for a project review. Let me inspect the tests. I need to summarize the result in the final answer.\n\n项目审查完成。',
  );

  assert.match(issue ?? '', /internal work narration/u);
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
