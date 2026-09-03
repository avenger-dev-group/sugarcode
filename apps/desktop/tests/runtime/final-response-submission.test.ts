import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractDelimitedFinalResponse,
  streamableDelimitedFinalResponse,
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

test('exposes only stream-safe content after a complete final boundary', () => {
  assert.equal(
    streamableDelimitedFinalResponse('Private reasoning.</thi'),
    undefined,
  );
  assert.equal(
    streamableDelimitedFinalResponse('Private reasoning.</think>答复'),
    '答复',
  );
  assert.equal(
    streamableDelimitedFinalResponse(
      'Draft<final_response>Answer</final_res',
    ),
    'Answer',
  );
  assert.equal(
    streamableDelimitedFinalResponse(
      'Draft<final_response>Answer</final_response>',
    ),
    'Answer',
  );
});
