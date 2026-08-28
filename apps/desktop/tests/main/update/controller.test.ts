import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareUpdateVersions,
  UpdateController,
  type UpdateControllerOptions,
} from '../../../src/main/update/controller.ts';

const GITHUB_RELEASE_API =
  'https://api.github.com/repos/avenger-dev-group/sugarcode/releases/latest';
const GITCODE_RELEASE_API =
  'https://api.gitcode.com/api/v5/repos/Simoonf/SugarCode/releases/latest?type=latest';
const GITCODE_DOWNLOAD_PAGE =
  'https://gitcode.com/Simoonf/SugarCode/releases';
const UPDATE_SOURCES = [
  {
    kind: 'gitcode',
    latestReleaseApiUrl: GITCODE_RELEASE_API,
    downloadPageUrl: GITCODE_DOWNLOAD_PAGE,
  },
  {
    kind: 'github',
    latestReleaseApiUrl: GITHUB_RELEASE_API,
    downloadPageUrl:
      'https://github.com/avenger-dev-group/sugarcode/releases/latest',
  },
] as const;

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
  const assets = new Map<string, Buffer>([
    ['update-manifest.json', manifestBytes],
    [installerName, installer],
  ]);
  const githubRelease = {
    tag_name: 'v3.1.0',
    draft: false,
    prerelease: false,
    assets: Array.from(assets, ([name, bytes]) => ({
      name,
      size: bytes.byteLength,
      browser_download_url: `https://github.com/avenger-dev-group/sugarcode/releases/download/v3.1.0/${name}`,
    })),
  };
  const gitcodeRelease = {
    tag_name: 'v3.1.0',
    prerelease: false,
    release_status: 'latest',
    assets: Array.from(assets, ([name]) => ({
      name,
      browser_download_url: `https://gitcode.com/Simoonf/SugarCode/releases/download/v3.1.0/${name}`,
    })),
  };
  const requestedUrls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (
      new URL(url).hostname.endsWith('gitcode.com') &&
      new Headers(init?.headers).get('user-agent') !== 'SugarCode/3.0.2'
    ) {
      return new Response(null, { status: 401 });
    }
    if (url === GITCODE_RELEASE_API) {
      return response(JSON.stringify(gitcodeRelease), 'application/json');
    }
    if (url === GITHUB_RELEASE_API) {
      return response(JSON.stringify(githubRelease), 'application/json');
    }
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    const bytes = assets.get(name);
    return bytes ? response(bytes) : new Response(null, { status: 404 });
  };
  return {
    root,
    downloadsDirectory,
    pendingStatePath,
    installer,
    installerName,
    fetch,
    requestedUrls,
  };
};

test('compares stable and prerelease update versions', () => {
  assert.equal(compareUpdateVersions('3.1.0', '3.0.9'), 1);
  assert.equal(compareUpdateVersions('3.1.0', '3.1.0-beta.2'), 1);
  assert.equal(compareUpdateVersions('3.1.0-beta.2', '3.1.0-beta.10'), -1);
  assert.throws(() => compareUpdateVersions('3.01.0', '3.1.0'));
});

test('silently downloads a verified installer and only then becomes ready', async () => {
  const fixture = await createFixture();
  const states: string[] = [];
  let launchedPath: string | null = null;
  let quit = false;
  const options: UpdateControllerOptions = {
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    sources: UPDATE_SOURCES,
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
    assert.equal(fixture.requestedUrls[0], GITCODE_RELEASE_API);
    assert.equal(fixture.requestedUrls.includes(GITHUB_RELEASE_API), true);
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

test('manual checks reuse the updater and report when the app is current', async () => {
  const fixture = await createFixture();
  const controller = new UpdateController({
    currentVersion: '3.1.0',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    sources: UPDATE_SOURCES,
    getInstallBlock: () => false,
    launchInstaller: async () => true,
    openDownloadPage: async () => true,
    quitApplication: () => undefined,
    fetch: fixture.fetch,
    retryDelaysMs: [],
  });
  const completed = new Promise<void>((resolve) => {
    controller.subscribe((snapshot) => {
      if (snapshot.status === 'upToDate') resolve();
    });
  });
  try {
    assert.deepEqual(controller.requestCheck(), {
      accepted: true,
      reason: 'accepted',
    });
    assert.equal(controller.getSnapshot().status, 'checking');
    assert.deepEqual(controller.requestCheck(), {
      accepted: false,
      reason: 'busy',
    });
    await completed;
    assert.equal(controller.getSnapshot().status, 'upToDate');
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
    sources: UPDATE_SOURCES,
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

test('falls back to GitHub when the GitCode release is unavailable', async () => {
  const fixture = await createFixture();
  const fallbackFetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === GITCODE_RELEASE_API) {
      fixture.requestedUrls.push(url);
      return new Response(null, { status: 503 });
    }
    return fixture.fetch(input, init);
  };
  const controller = new UpdateController({
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    sources: UPDATE_SOURCES,
    getInstallBlock: () => false,
    launchInstaller: async () => true,
    openDownloadPage: async () => true,
    quitApplication: () => undefined,
    fetch: fallbackFetch,
    retryDelaysMs: [],
  });
  try {
    await controller.checkNow();
    assert.equal(controller.getSnapshot().status, 'ready');
    assert.deepEqual(fixture.requestedUrls.slice(0, 2), [
      GITCODE_RELEASE_API,
      GITHUB_RELEASE_API,
    ]);
  } finally {
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('selects the highest version when both update sources have newer releases', async () => {
  const fixture = await createFixture();
  const gitcodeInstallerName = 'SugarCode-3.0.9-macos-arm64.dmg';
  const gitcodeInstaller = Buffer.from('older SugarCode installer');
  const gitcodeSha256 = (await import('node:crypto'))
    .createHash('sha256')
    .update(gitcodeInstaller)
    .digest('hex');
  const gitcodeManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      version: '3.0.9',
      publishedAt: '2026-08-11T00:00:00.000Z',
      platforms: {
        'darwin-arm64': {
          file: gitcodeInstallerName,
          size: gitcodeInstaller.byteLength,
          sha256: gitcodeSha256,
        },
      },
    }),
  );
  const gitcodeAssets = new Map<string, Buffer>([
    ['update-manifest.json', gitcodeManifest],
    [gitcodeInstallerName, gitcodeInstaller],
  ]);
  const gitcodeRelease = {
    tag_name: 'v3.0.9',
    prerelease: false,
    release_status: 'latest',
    assets: Array.from(gitcodeAssets, ([name]) => ({
      name,
      browser_download_url: `https://gitcode.com/Simoonf/SugarCode/releases/download/v3.0.9/${name}`,
    })),
  };
  const mixedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === GITCODE_RELEASE_API) {
      fixture.requestedUrls.push(url);
      return response(JSON.stringify(gitcodeRelease), 'application/json');
    }
    if (new URL(url).hostname.endsWith('gitcode.com')) {
      fixture.requestedUrls.push(url);
      const name = decodeURIComponent(
        new URL(url).pathname.split('/').at(-1) ?? '',
      );
      const bytes = gitcodeAssets.get(name);
      return bytes ? response(bytes) : new Response(null, { status: 404 });
    }
    return fixture.fetch(input, init);
  };
  const controller = new UpdateController({
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    sources: UPDATE_SOURCES,
    getInstallBlock: () => false,
    launchInstaller: async () => true,
    openDownloadPage: async () => true,
    quitApplication: () => undefined,
    fetch: mixedFetch,
    retryDelaysMs: [],
  });
  try {
    await controller.checkNow();
    assert.deepEqual(controller.getSnapshot(), {
      revision: 3,
      status: 'ready',
      version: '3.1.0',
    });
    assert.equal(fixture.requestedUrls.includes(GITHUB_RELEASE_API), true);
    assert.equal(
      fixture.requestedUrls.some((url) => url.endsWith(gitcodeInstallerName)),
      false,
    );
  } finally {
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('checks for the latest release before allowing a restored update to install', async () => {
  const fixture = await createFixture();
  const restoredInstaller = Buffer.from('previous SugarCode installer');
  const restoredInstallerName = 'SugarCode-3.0.5-macos-arm64.dmg';
  const restoredInstallerPath = path.join(
    fixture.downloadsDirectory,
    restoredInstallerName,
  );
  const restoredSha256 = (await import('node:crypto'))
    .createHash('sha256')
    .update(restoredInstaller)
    .digest('hex');
  await mkdir(fixture.downloadsDirectory, { recursive: true });
  await mkdir(path.dirname(fixture.pendingStatePath), { recursive: true });
  await writeFile(restoredInstallerPath, restoredInstaller);
  await writeFile(
    fixture.pendingStatePath,
    JSON.stringify({
      version: '3.0.5',
      installerPath: restoredInstallerPath,
      sha256: restoredSha256,
      size: restoredInstaller.byteLength,
    }),
  );

  let releaseChecks: (() => void) | undefined;
  const releaseCheckGate = new Promise<void>((resolve) => {
    releaseChecks = resolve;
  });
  let announceCheck: (() => void) | undefined;
  const checkStarted = new Promise<void>((resolve) => {
    announceCheck = resolve;
  });
  const delayedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === GITCODE_RELEASE_API || url === GITHUB_RELEASE_API) {
      announceCheck?.();
      await releaseCheckGate;
    }
    return fixture.fetch(input, init);
  };
  let launchedPath: string | null = null;
  const controller = new UpdateController({
    currentVersion: '3.0.2',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    sources: UPDATE_SOURCES,
    getInstallBlock: () => false,
    launchInstaller: async (installerPath) => {
      launchedPath = installerPath;
      return true;
    },
    openDownloadPage: async () => true,
    quitApplication: () => undefined,
    fetch: delayedFetch,
    retryDelaysMs: [],
  });
  try {
    const startup = controller.start();
    await checkStarted;
    assert.equal(controller.getSnapshot().status, 'checking');
    assert.deepEqual(await controller.install(), {
      accepted: false,
      reason: 'busy',
    });
    assert.equal(launchedPath, null);

    releaseChecks?.();
    await startup;
    assert.deepEqual(controller.getSnapshot(), {
      revision: 4,
      status: 'ready',
      version: '3.1.0',
    });
    assert.deepEqual(await controller.install(), {
      accepted: true,
      reason: 'accepted',
    });
    assert.equal(
      launchedPath,
      path.join(fixture.downloadsDirectory, fixture.installerName),
    );
    await assert.rejects(readFile(restoredInstallerPath), { code: 'ENOENT' });
  } finally {
    releaseChecks?.();
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('removes the installer after the updated application starts', async () => {
  const fixture = await createFixture();
  const installerPath = path.join(
    fixture.downloadsDirectory,
    fixture.installerName,
  );
  const legacyInstallerPath = path.join(
    fixture.downloadsDirectory,
    'SugarCode-3.0.8-macos-arm64.dmg',
  );
  const futureInstallerPath = path.join(
    fixture.downloadsDirectory,
    'SugarCode-3.2.0-macos-arm64.dmg',
  );
  const unrelatedPath = path.join(
    fixture.downloadsDirectory,
    'SugarCode-notes.txt',
  );
  await mkdir(fixture.downloadsDirectory, { recursive: true });
  await mkdir(path.dirname(fixture.pendingStatePath), { recursive: true });
  await writeFile(installerPath, fixture.installer);
  await writeFile(legacyInstallerPath, 'legacy installer');
  await writeFile(futureInstallerPath, 'future installer');
  await writeFile(unrelatedPath, 'keep me');
  await writeFile(
    fixture.pendingStatePath,
    JSON.stringify({
      version: '3.1.0',
      installerPath,
      sha256: (await import('node:crypto'))
        .createHash('sha256')
        .update(fixture.installer)
        .digest('hex'),
      size: fixture.installer.byteLength,
    }),
  );

  const controller = new UpdateController({
    currentVersion: '3.1.0',
    platform: 'darwin-arm64',
    downloadsDirectory: fixture.downloadsDirectory,
    pendingStatePath: fixture.pendingStatePath,
    sources: UPDATE_SOURCES,
    getInstallBlock: () => false,
    launchInstaller: async () => true,
    openDownloadPage: async () => true,
    quitApplication: () => undefined,
    fetch: fixture.fetch,
    retryDelaysMs: [],
  });
  try {
    await controller.start();
    assert.equal(controller.getSnapshot().status, 'upToDate');
    await assert.rejects(readFile(installerPath), { code: 'ENOENT' });
    await assert.rejects(readFile(legacyInstallerPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.pendingStatePath), { code: 'ENOENT' });
    assert.equal(await readFile(futureInstallerPath, 'utf8'), 'future installer');
    assert.equal(await readFile(unrelatedPath, 'utf8'), 'keep me');
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
    sources: UPDATE_SOURCES,
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
    assert.equal(opened, GITCODE_DOWNLOAD_PAGE);
  } finally {
    controller.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
