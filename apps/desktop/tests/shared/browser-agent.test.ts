import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isBrowserAgentAction,
  isBrowserAgentResult,
} from '../../src/shared/browser-agent.ts';

const sessionId = '9cf78522-8ca0-4f7d-a861-87a0fb61d612';

test('browser Agent accepts only bounded fixed actions', () => {
  assert.equal(
    isBrowserAgentAction({ action: 'open', url: 'http://127.0.0.1:5173' }),
    true,
  );
  assert.equal(
    isBrowserAgentAction({ action: 'click', sessionId, selector: '#save' }),
    true,
  );
  assert.equal(
    isBrowserAgentAction({
      action: 'screenshot',
      sessionId,
      path: 'settings-state.png',
    }),
    true,
  );
  assert.equal(
    isBrowserAgentAction({
      action: 'screenshot',
      sessionId,
      path: '../outside.png',
    }),
    false,
  );
  assert.equal(
    isBrowserAgentAction({ action: 'wait', sessionId, milliseconds: 10_001 }),
    false,
  );
  assert.equal(
    isBrowserAgentAction({ action: 'evaluate', sessionId, script: 'alert(1)' }),
    false,
  );
});

test('browser Agent result rejects oversized or malformed snapshots', () => {
  assert.equal(isBrowserAgentResult({ ok: false, error: 'cancelled' }), true);
  assert.equal(
    isBrowserAgentResult({
      ok: true,
      snapshot: {
        sessionId,
        url: 'http://127.0.0.1:5173/',
        title: 'Fixture',
        text: 'Ready',
        elements: [{ selector: '#save', tag: 'button', label: 'Save' }],
      },
    }),
    true,
  );
  assert.equal(
    isBrowserAgentResult({ ok: true, snapshot: { sessionId } }),
    false,
  );
});
