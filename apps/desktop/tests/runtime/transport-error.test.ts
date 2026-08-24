import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTransportError } from '../../src/runtime/models/transport-error.ts';

test('transport classifier recognizes Undici socket termination through its cause', () => {
  const cause = Object.assign(new Error('other side closed'), {
    code: 'UND_ERR_SOCKET',
  });
  const error = new TypeError('terminated', { cause });

  assert.deepEqual(classifyTransportError(error), {
    kind: 'connection',
    code: 'UND_ERR_SOCKET',
  });
});

test('transport classifier distinguishes stable timeout codes', () => {
  const cause = Object.assign(new Error('headers timed out'), {
    code: 'UND_ERR_HEADERS_TIMEOUT',
  });

  assert.deepEqual(
    classifyTransportError(new TypeError('fetch failed', { cause })),
    { kind: 'timeout', code: 'UND_ERR_HEADERS_TIMEOUT' },
  );
});

test('transport classifier does not make arbitrary provider errors retryable', () => {
  assert.equal(classifyTransportError(new Error('terminated')), undefined);
  assert.equal(
    classifyTransportError(new Error('provider rejected the request')),
    undefined,
  );
});
