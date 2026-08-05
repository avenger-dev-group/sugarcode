import assert from 'node:assert/strict';
import test from 'node:test';

import { isToolValidationRejectedItem } from '../../../../src/main/app-server/conversation/tool-validation-protocol.ts';

const rejection = {
  type: 'toolValidationRejected',
  id: '00000000-0002-7000-8000-000000001405',
  callId: 'chatcmpl-tool-bde02b193a056385',
  name: 'workspace/apply-patch',
  kind: 'expectedMismatch',
  argumentsBytes: 218,
  argumentsSha256: 'a'.repeat(64),
  editIndex: 1,
  hunkIndex: 1,
  line: 12,
  expectedSummary: `bytes=3,sha256=${'b'.repeat(64)}`,
  actualSummary: `bytes=4,sha256=${'c'.repeat(64)}`,
  suggestedAction: 'readFileAndRebase',
};

test('public toolValidationRejected items are accepted without pseudo ToolCalls', () => {
  assert.equal(isToolValidationRejectedItem(rejection), true);
  assert.equal(
    isToolValidationRejectedItem({
      type: 'toolCall',
      id: rejection.id,
      callId: rejection.callId,
      name: rejection.name,
      arguments: {},
    }),
    false,
  );
});

test('all model-facing validation rejection kinds remain recoverable', () => {
  for (const kind of [
    'batchRejected',
    'invalidArguments',
    'unknownTool',
    'headerCountMismatch',
    'rangeOutOfBounds',
    'expectedMismatch',
    'baseRevisionMismatch',
    'unsupportedDiffFeature',
  ]) {
    assert.equal(isToolValidationRejectedItem({ ...rejection, kind }), true);
  }
});

test('malformed or operational records are not swallowed as validation items', () => {
  assert.equal(
    isToolValidationRejectedItem({ ...rejection, kind: 'accessDenied' }),
    false,
  );
  assert.equal(
    isToolValidationRejectedItem({ ...rejection, argumentsSha256: 'bad' }),
    false,
  );
  assert.equal(
    isToolValidationRejectedItem({ ...rejection, unexpected: true }),
    false,
  );
});
