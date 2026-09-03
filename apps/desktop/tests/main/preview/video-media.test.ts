import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VideoPreviewMedia, videoByteRange } from '../../../src/main/preview/video-media.ts';
import type { WorkspaceLaunchContext } from '../../../src/main/workspace/controller.ts';

test('video byte ranges support seeking, suffixes, bounds and malformed requests', () => {
  assert.deepEqual(videoByteRange('bytes=3-6', 10), { start: 3, end: 6 });
  assert.deepEqual(videoByteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(videoByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(videoByteRange('bytes=0-999', 10), { start: 0, end: 9 });
  for (const value of ['bytes=-0', 'bytes=10-', 'bytes=7-3', 'bytes=0-2,5-7', 'bytes=-', 'invalid']) {
    assert.equal(videoByteRange(value, 10), null, value);
  }
});

test('video streaming returns content type, ranges, HEAD, and revokes tokens on workspace change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-video-preview-'));
  const file = path.join(root, 'demo.mp4');
  await writeFile(file, '0123456789');
  let workspace: WorkspaceLaunchContext = {
    generation: 1, workspaceId: 'workspace', threadId: 'thread', path: root, name: 'fixture',
  };
  const media = new VideoPreviewMedia(() => workspace);
  try {
    const grant = media.grant(workspace, 'demo.mp4', await realpath(file));
    const full = await media.respond(new Request(grant.url));
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), '0123456789');
    const partial = await media.respond(new Request(grant.url, { headers: { Range: 'bytes=4-7' } }));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 4-7/10');
    assert.equal(partial.headers.get('content-length'), '4');
    assert.equal(await partial.text(), '4567');
    const head = await media.respond(new Request(grant.url, { method: 'HEAD' }));
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
    assert.equal((await media.respond(new Request(grant.url, { method: 'POST' }))).status, 405);
    assert.equal((await media.respond(new Request(grant.url, { headers: { Range: 'bytes=90-' } }))).status, 416);
    assert.equal((await media.respond(new Request(`${grant.url}?path=/etc/passwd`))).status, 404);
    workspace = { ...workspace, threadId: 'other-thread' };
    assert.equal((await media.respond(new Request(grant.url))).status, 404);
    workspace = { ...workspace, threadId: 'thread', generation: 2 };
    assert.equal((await media.respond(new Request(grant.url))).status, 404);
    const second = media.grant(workspace, 'demo.mp4', await realpath(file));
    media.revoke(second.sessionId);
    assert.equal((await media.respond(new Request(second.url))).status, 404);
  } finally {
    media.clear();
    await rm(root, { recursive: true, force: true });
  }
});

test('a video grant cannot be redirected to a symlink outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-video-preview-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-video-outside-'));
  const file = path.join(root, 'demo.mp4');
  await writeFile(file, 'video');
  const workspace = { generation: 1, workspaceId: 'w', threadId: 't', path: root, name: 'fixture' };
  const media = new VideoPreviewMedia(() => workspace);
  try {
    const grant = media.grant(workspace, 'demo.mp4', await realpath(file));
    await writeFile(path.join(outside, 'other.mp4'), 'private');
    await unlink(file);
    await symlink(path.join(outside, 'other.mp4'), file);
    assert.equal((await media.respond(new Request(grant.url))).status, 404);
  } finally {
    media.clear();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
