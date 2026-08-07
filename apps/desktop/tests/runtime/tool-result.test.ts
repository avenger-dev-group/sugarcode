import assert from 'node:assert/strict';
import test from 'node:test';

import { toolResultFailed } from '../../src/runtime/tool-result.ts';

test('tool result failure classification includes nested process outcomes', () => {
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'exitCode', code: 1 } },
    }),
    true,
  );
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'exitCode', code: 0 } },
    }),
    false,
  );
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'signal', signal: 9 } },
    }),
    true,
  );
  assert.equal(
    toolResultFailed({
      status: 'completed',
      output: { outcome: { type: 'timedOut' } },
    }),
    true,
  );
});

test('tool result failure classification preserves direct tool results', () => {
  assert.equal(toolResultFailed({ ok: false, error: 'notFound' }), true);
  assert.equal(toolResultFailed({ ok: true, content: 'fixture' }), false);
});
