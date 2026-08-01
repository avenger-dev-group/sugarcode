import assert from 'node:assert/strict';
import test from 'node:test';

import { isRecoverableToolValidationItem } from '../../../../src/main/app-server/conversation/tool-validation-protocol.ts';

const redactedCall = {
  type: 'toolCall',
  id: 'item_0000000000001405',
  callId: 'chatcmpl-tool-bde02b193a056385',
  name: 'shell/exec',
  path: '',
};

const validationResult = {
  type: 'toolResult',
  id: 'item_0000000000001406',
  callId: 'chatcmpl-tool-bde02b193a056385',
  name: 'shell/exec',
  result: {
    type: 'error',
    kind: 'invalidArguments',
  },
};

test('task 0035 rejected tool Items remain recoverable', () => {
  assert.equal(isRecoverableToolValidationItem(redactedCall), true);
  assert.equal(isRecoverableToolValidationItem(validationResult), true);
});

test('all model-facing validation rejection kinds remain recoverable', () => {
  for (const kind of [
    'batchRejected',
    'invalidArguments',
    'unknownTool',
  ]) {
    assert.equal(
      isRecoverableToolValidationItem({
        ...validationResult,
        result: { type: 'error', kind },
      }),
      true,
    );
  }
});

test('operational failures and non-redacted calls still require normal parsing', () => {
  assert.equal(
    isRecoverableToolValidationItem({
      ...validationResult,
      result: { type: 'error', kind: 'accessDenied' },
    }),
    false,
  );
  assert.equal(
    isRecoverableToolValidationItem({
      ...redactedCall,
      path: '.',
      command: '/usr/bin/git',
      arguments: ['status'],
    }),
    false,
  );
});

test('malformed protocol records are never swallowed as model validation errors', () => {
  assert.equal(
    isRecoverableToolValidationItem({
      ...redactedCall,
      callId: '',
    }),
    false,
  );
  assert.equal(
    isRecoverableToolValidationItem({
      ...validationResult,
      unexpected: true,
    }),
    false,
  );
});
