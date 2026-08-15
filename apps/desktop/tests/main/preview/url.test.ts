import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAllowedPreviewRequest,
  parsePreviewLocation,
} from '../../../src/main/preview/url.ts';

test('preview locations accept explicit-port loopback hosts only', () => {
  assert.deepEqual(parsePreviewLocation('http://localhost:5173/app'), {
    url: 'http://localhost:5173/app',
    origin: 'http://localhost:5173',
  });
  assert.ok(parsePreviewLocation('http://127.0.0.1:3000/'));
  assert.ok(parsePreviewLocation('http://[::1]:8080/'));
  assert.equal(parsePreviewLocation('http://localhost/'), null);
  assert.equal(parsePreviewLocation('http://0.0.0.0:3000/'), null);
  assert.equal(parsePreviewLocation('https://localhost:3000/'), null);
});

test('interactive preview traffic stays on the confirmed local origin', () => {
  const location = parsePreviewLocation('http://localhost:5173/app');
  assert.ok(location);

  assert.equal(
    isAllowedPreviewRequest(
      location,
      'http://localhost:5173/api/todos',
      'POST',
      'xhr',
    ),
    true,
  );
  assert.equal(
    isAllowedPreviewRequest(
      location,
      'ws://localhost:5173/hmr',
      'GET',
      'webSocket',
    ),
    true,
  );
  assert.equal(
    isAllowedPreviewRequest(
      location,
      'http://localhost:5173/frame',
      'GET',
      'subFrame',
    ),
    true,
  );
  assert.equal(
    isAllowedPreviewRequest(
      location,
      'http://localhost:5174/api/todos',
      'POST',
      'xhr',
    ),
    false,
  );
  assert.equal(
    isAllowedPreviewRequest(
      location,
      'http://example.com/script.js',
      'GET',
      'script',
    ),
    false,
  );
  assert.equal(
    isAllowedPreviewRequest(
      location,
      'http://localhost:5173/plugin',
      'GET',
      'object',
    ),
    false,
  );
});
