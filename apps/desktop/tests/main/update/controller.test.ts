import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareUpdateVersions,
  UpdateController,
  type UpdateControllerOptions,
} from '../../../src/main/update/controller.ts';

const RELEASE_API =
  'https://api.github.com/repos/avenger-dev-group/sugarcode/releases/latest';
const DOWNLOAD_PAGE =
  'https://github.com/avenger-dev-group/sugarcode/releases/latest';

const response = (
  body: string | Buffer,
  contentType = 'application/octet-stream',
) =>
  new Response(
    typeof body === 'string'
      ? body
      : body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
    {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(
        typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength,
      ),
    },
    },
  );

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-update-test-'));
  const downloadsDirectory = path.join(root, 'Downloads');
  const pendingStatePath = path.join(root, 'state', 'pending.json');
  const installer = Buffer.from('verified SugarCode installer');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const installerName = 'SugarCode-3.1.0-macos-arm64.dmg';
  const sha256 = (await import('node:crypto'))
    .createHash('sha256')
    .update(installer)
    .digest('hex');
  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: '3.1.0',
        publishedAt: '2026-08-12T00:00:00.000Z',
        platforms: {
          'darwin-arm64': {
            file: installerName,
            size: installer.byteLength,
            sha256,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const signatureBytes = Buffer.from(
    `${sign(null, manifestBytes, privateKey).toString('base64')}\n`,
  );
  const assets = new Map<string, Buffer>([
    ['update-manifest.json', manifestBytes],
    ['update-manifest.sig', signatureBytes],
    [installerName, installer],
  ]);
  const release = {
    tag_name: 'v3.1.0',
    draft: false,
    prerelease: false,
    assets: Array.from(assets, ([name, bytes]) => ({
      name,
      size: bytes.byteLength,
      browser_download_url: `https://github.com/avenger-dev-group/sugarcode/releases/download/v3.1.0/${name}`,
    })),
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === RELEASE_API) {
      return response(JSON.stringify(release), 'application/json');
    }
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    const bytes = assets.get(name);
    return bytes ? response(bytes) : new Response(null, { status: 404 });
  };
  return {
    root,
    downloadsDirectory,
    pendingStatePath,
    publicKeyPem,
    installer,
    installerName,
    fetch,
  };
};

test('compares stable and prerelease update versions', () => {
  assert.equal(compareUpdateVersions('3.1.0', '3.0.9'), 1);
  assert.equal(compareUpdateVersions('3.1.0', '3.1.0-beta.2'), 1);
  assert.equal(compareUpdateVersions('3.1.0-beta.2', '3.1.0-beta.10'), -1);
  assert.throws(() => compareUpdateVersions('3.01.0', '3.1.0'));
});

test('silently downloads a signed installer and only then becomes ready', async () => {
  const fixture = await createFixture();
  const states: string[] = [];
  let launchedPath: string | null = null;
  let quit = false;
  const options: UpdateControllerOptions = {
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    latestReleaseApiUrl: RELEASE_API,
    downloadPageUrl: DOWNLOAD_PAGE,
    publicKeyPem: fixture.publicKeyPem,
    getInstallBlock: () => false,
    launchInstaller: async (installerPath) => {
      launchedPath = installerPath;
      return true;
    },
    openDownloadPage: async () => true,
    quitApplication: () => {
      quit = true;
    },
    fetch: fixture.fetch,
    retryDelaysMs: [],
  };
  const controller = new UpdateController(options);
  controller.subscribe((snapshot) => states.push(snapshot.status));
  try {
    await controller.checkNow();
    assert.deepEqual(states, ['checking', 'downloading', 'ready']);
    assert.deepEqual(controller.getSnapshot(), {
      revision: 3,
      status: 'ready',
      version: '3.1.0',
    });
    assert.deepEqual(
      await readFile(path.join(fixture.downloadsDirectory, fixture.installerName)),
      fixture.installer,
    );
    assert.deepEqual(await controller.install(), {
      accepted: true,
      reason: 'accepted',
    });
    assert.equal(
      launchedPath,
      path.join(fixture.downloadsDirectory, fixture.installerName),
    );
    assert.equal(quit, true);
  } finally {
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('blocks installation while work is active', async () => {
  const fixture = await createFixture();
  const controller = new UpdateController({
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    latestReleaseApiUrl: RELEASE_API,
    downloadPageUrl: DOWNLOAD_PAGE,
    publicKeyPem: fixture.publicKeyPem,
    getInstallBlock: () => true,
    launchInstaller: async () => {
      throw new Error('must not launch');
    },
    openDownloadPage: async () => true,
    quitApplication: () => undefined,
    fetch: fixture.fetch,
    retryDelaysMs: [],
  });
  try {
    await controller.checkNow();
    assert.deepEqual(await controller.install(), {
      accepted: false,
      reason: 'busy',
    });
    assert.equal(controller.getSnapshot().status, 'ready');
  } finally {
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('shows the download-page fallback only after repeated failures', async () => {
  const fixture = await createFixture();
  let opened = '';
  const controller = new UpdateController({
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    latestReleaseApiUrl: RELEASE_API,
    downloadPageUrl: DOWNLOAD_PAGE,
    publicKeyPem: fixture.publicKeyPem,
    getInstallBlock: () => false,
    launchInstaller: async () => false,
    openDownloadPage: async (url) => {
      opened = url;
      return true;
    },
    quitApplication: () => undefined,
    fetch: async () => new Response(null, { status: 503 }),
    retryDelaysMs: [60_000, 60_000],
  });
  try {
    await controller.checkNow();
    assert.equal(controller.getSnapshot().status, 'idle');
    await controller.checkNow();
    assert.equal(controller.getSnapshot().status, 'idle');
    await controller.checkNow();
    assert.equal(controller.getSnapshot().status, 'fallback');
    assert.deepEqual(await controller.openDownloadPage(), {
      accepted: true,
      reason: 'accepted',
    });
    assert.equal(opened, DOWNLOAD_PAGE);
  } finally {
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
