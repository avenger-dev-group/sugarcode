import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDashscopeTemporaryMediaPublisher,
  effectiveMediaTransport,
} from '../../src/runtime/temporary-media.ts';

test('automatic media transport recognizes DashScope endpoints only', () => {
  assert.equal(
    effectiveMediaTransport(
      'auto',
      'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    ),
    'dashscopeTemporaryUrl',
  );
  assert.equal(
    effectiveMediaTransport('auto', 'https://api.openai.com/v1'),
    'inline',
  );
  assert.equal(
    effectiveMediaTransport('inline', 'https://dashscope.aliyuncs.com/v1'),
    'inline',
  );
});

test('DashScope publisher obtains a scoped policy and uploads one private file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sugarcode-upload-test-'));
  const filePath = path.join(directory, 'meeting.mov');
  await writeFile(filePath, Buffer.from('video'));
  const requests: Array<Readonly<{
    url: string;
    method: string;
    headers: Headers;
    body: BodyInit | null | undefined;
  }>> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        data: {
          policy: 'policy',
          signature: 'signature',
          upload_dir: 'dashscope-instant/fixture',
          upload_host: 'https://upload.example.invalid',
          max_file_size_mb: '100',
          oss_access_key_id: 'access-key',
          x_oss_object_acl: 'private',
          x_oss_forbid_overwrite: 'true',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('', { status: 200 });
  };
  try {
    const publisher = createDashscopeTemporaryMediaPublisher({
      baseUrl:
        'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: 'fixture-secret',
      fetch: mockFetch,
    });
    const published = await publisher.publish({
      filePath,
      fileName: 'meeting.mov',
      mediaType: 'video/quicktime',
      sha256: 'a'.repeat(64),
      sizeBytes: 5,
      modelId: 'qwen-omni-fixture',
      signal: new AbortController().signal,
    });
    assert.equal(
      published.uri,
      `oss://dashscope-instant/fixture/${'a'.repeat(16)}-meeting.mov`,
    );
    assert.equal(requests.length, 2);
    assert.match(requests[0]?.url ?? '', /action=getPolicy/u);
    assert.match(requests[0]?.url ?? '', /model=qwen-omni-fixture/u);
    assert.equal(
      requests[0]?.headers.get('authorization'),
      'Bearer fixture-secret',
    );
    assert.equal(requests[1]?.method, 'POST');
    assert.ok(requests[1]?.body instanceof FormData);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
