import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPreviewArtifactOpenRequest,
  isPreviewArtifactRequest,
  isPreviewBoundsRequest,
  isPreviewNavigateRequest,
  isPreviewOpenRequest,
  isPreviewStateSnapshot,
} from '../../src/shared/preview.ts';

test('artifact preview requests accept relative HTML and video files', () => {
  const previewId = '5f53ba9a-f8ea-4b8f-b0db-f1abde48a86d';
  assert.equal(
    isPreviewArtifactOpenRequest({
      previewId,
      generation: 2,
      path: 'site/index.html',
    }),
    true,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: 'landing.htm' }),
    true,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: 'renders/final.mp4' }),
    true,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: 'renders/final.webm' }),
    true,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: '../index.html' }),
    false,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: '/tmp/index.html' }),
    false,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: 'src/main.tsx' }),
    false,
  );
  assert.equal(
    isPreviewArtifactRequest({ generation: 2, path: 'renders/final.mkv' }),
    false,
  );
});

const sessionId = '12345678-1234-4234-9234-123456789abc';
const secondSessionId = '22345678-1234-4234-9234-123456789abc';

test('preview open requests bind a local browser tab to its isolated session', () => {
  assert.equal(
    isPreviewOpenRequest({
      previewId: sessionId,
      generation: 4,
      url: 'http://localhost:3000/',
    }),
    true,
  );
  assert.equal(
    isPreviewOpenRequest({
      generation: 4,
      url: 'http://localhost:3000/',
    }),
    false,
  );
});

test('preview snapshots preserve multiple browser tabs with unique ids', () => {
  assert.equal(
    isPreviewStateSnapshot({
      revision: 7,
      tabs: [
        {
          previewId: sessionId,
          status: 'ready',
          generation: 4,
          sessionId,
          url: 'http://localhost:3000/',
          origin: 'http://localhost:3000',
          visible: true,
          canGoBack: false,
          canGoForward: false,
        },
        {
          previewId: secondSessionId,
          status: 'opening',
          generation: 4,
          sessionId: secondSessionId,
          url: 'http://127.0.0.1:5173/',
          origin: 'http://127.0.0.1:5173',
          visible: false,
        },
      ],
    }),
    true,
  );
  assert.equal(
    isPreviewStateSnapshot({
      revision: 8,
      tabs: [
        {
          previewId: sessionId,
          status: 'failed',
          generation: 4,
          url: 'http://localhost:3000/',
          origin: 'http://localhost:3000',
          error: 'loadFailed',
        },
        {
          previewId: sessionId,
          status: 'failed',
          generation: 4,
          url: 'http://localhost:5173/',
          origin: 'http://localhost:5173',
          error: 'loadFailed',
        },
      ],
    }),
    false,
  );
});

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

test('video preview state uses a scoped media token rather than a browser file URL', () => {
  const tab = {
    previewId: sessionId, generation: 4, sessionId, status: 'video',
    url: `sugarcode-video://media/${sessionId}`, origin: 'sugarcode-video://media',
    path: 'renders/final.mp4',
  };
  assert.equal(isPreviewStateSnapshot({ revision: 1, tabs: [tab] }), true);
  for (const change of [
    { path: '../escape.mp4' }, { path: 'index.html' },
    { url: 'file:///outside.mp4' }, { url: `sugarcode-video://media/${secondSessionId}` },
  ]) {
    assert.equal(isPreviewStateSnapshot({ revision: 1, tabs: [{ ...tab, ...change }] }), false);
  }
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
