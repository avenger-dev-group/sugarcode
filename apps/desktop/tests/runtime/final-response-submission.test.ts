import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSubmitFinalResponseTool,
  extractDelimitedFinalResponse,
  MAX_FINAL_RESPONSE_BYTES,
  type FinalResponseSubmissionGuard,
} from '../../src/runtime/final-response-submission.ts';

test('extracts only explicitly delimited final content without language heuristics', () => {
  assert.equal(
    extractDelimitedFinalResponse(
      'Private reasoning.</think>最终答复。',
    ),
    '最终答复。',
  );
  assert.equal(
    extractDelimitedFinalResponse(
      'Draft<final_response>English final answer.</final_response>',
    ),
    'English final answer.',
  );
  assert.equal(
    extractDelimitedFinalResponse('Ordinary unstructured answer.'),
    undefined,
  );
  assert.equal(
    extractDelimitedFinalResponse(
      '<final_response>Answer</final_response>unexpected tail',
    ),
    undefined,
  );
});

const runTool = async (
  content: unknown,
  validate: (value: string) => string | undefined = () => undefined,
): Promise<Readonly<{ result: unknown; guard: FinalResponseSubmissionGuard }>> => {
  const guard: FinalResponseSubmissionGuard = {};
  const tool = createSubmitFinalResponseTool({ guard, validate });
  const result = await tool.runAsync({
    args: { content },
    toolContext: {} as never,
  });
  return { result, guard };
};

test('accepts and stores only the trimmed user-facing response', async () => {
  const { result, guard } = await runTool('  修复已完成。  ');

  assert.deepEqual(result, {
    ok: true,
    message:
      'The final response was accepted and will be shown to the user. Do not repeat it.',
  });
  assert.equal(guard.content, '修复已完成。');
});

test('rejects empty, oversized, and validator-rejected submissions', async () => {
  const empty = await runTool('   ');
  assert.equal(empty.guard.content, undefined);
  assert.match(JSON.stringify(empty.result), /must not be empty/u);

  const oversized = await runTool('a'.repeat(MAX_FINAL_RESPONSE_BYTES + 1));
  assert.equal(oversized.guard.content, undefined);
  assert.match(JSON.stringify(oversized.result), /exceeds/u);

  const invalid = await runTool('Internal draft', () =>
    'The response contains private work.',
  );
  assert.equal(invalid.guard.content, undefined);
  assert.match(JSON.stringify(invalid.result), /private work/u);
});
