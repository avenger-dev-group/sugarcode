import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPreviewBoundsRequest,
  isPreviewNavigateRequest,
} from '../../src/shared/preview.ts';

const sessionId = '12345678-1234-4234-9234-123456789abc';

test('preview bounds accept a bounded visible rectangle or an explicit hide', () => {
  assert.equal(
    isPreviewBoundsRequest({
      generation: 4,
      sessionId,
      bounds: { x: 900, y: 80, width: 720, height: 680 },
    }),
    true,
  );
  assert.equal(
    isPreviewBoundsRequest({ generation: 4, sessionId, bounds: null }),
    true,
  );
  assert.equal(
    isPreviewBoundsRequest({
      generation: 4,
      sessionId,
      bounds: { x: 0, y: 0, width: 0, height: 680 },
    }),
    false,
  );
  assert.equal(
    isPreviewBoundsRequest({
      generation: 4,
      sessionId,
      bounds: { x: -1, y: 0, width: 720, height: 680 },
    }),
    false,
  );
});

test('preview navigation requires a bounded url and exact session shape', () => {
  assert.equal(
    isPreviewNavigateRequest({
      generation: 4,
      sessionId,
      url: 'http://localhost:3000/account',
    }),
    true,
  );
  assert.equal(
    isPreviewNavigateRequest({
      generation: 4,
      sessionId,
      url: 'http://localhost:3000/',
      unexpected: true,
    }),
    false,
  );
});
