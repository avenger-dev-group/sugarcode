import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  type WriteStream,
} from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type {
  UpdateActionResult,
  UpdateStateSnapshot,
} from '@/shared/update';

const MANIFEST_NAME = 'update-manifest.json';
const SIGNATURE_NAME = 'update-manifest.sig';
const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_INITIAL_DELAY_MS = 15_000;
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

type Listener = (snapshot: UpdateStateSnapshot) => void;

type UpdatePlatform = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';

type ManifestPlatform = Readonly<{
  file: string;
  size: number;
  sha256: string;
}>;

type UpdateManifest = Readonly<{
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  notes?: string;
  platforms: Readonly<Record<string, ManifestPlatform>>;
}>;

type GitHubReleaseAsset = Readonly<{
  name: string;
  size: number;
  browser_download_url: string;
}>;

type GitHubRelease = Readonly<{
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: readonly GitHubReleaseAsset[];
}>;

type PendingUpdate = Readonly<{
  version: string;
  installerPath: string;
  sha256: string;
  size: number;
  manifestBase64: string;
  signatureBase64: string;
}>;

export type UpdateControllerOptions = Readonly<{
  currentVersion: string;
  platform: UpdatePlatform | null;
  downloadsDirectory: string;
  pendingStatePath: string;
  latestReleaseApiUrl: string;
  downloadPageUrl: string;
  publicKeyPem: string;
  getInstallBlock: () => boolean;
  launchInstaller: (installerPath: string) => Promise<boolean>;
  openDownloadPage: (url: string) => Promise<boolean>;
  quitApplication: () => void;
  fetch?: typeof fetch;
  initialDelayMs?: number;
  checkIntervalMs?: number;
  retryDelaysMs?: readonly number[];
}>;

const accepted = (): UpdateActionResult => ({
  accepted: true,
  reason: 'accepted',
});

const rejected = (
  reason: Exclude<UpdateActionResult['reason'], 'accepted'>,
): UpdateActionResult => ({ accepted: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

type ParsedSemver = Readonly<{
  core: readonly [number, number, number];
  prerelease: readonly string[];
}>;

const parseSemver = (value: string): ParsedSemver | null => {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const prerelease = match[4]?.split('.') ?? [];
  if (
    prerelease.some(
      (identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith('0'),
    )
  ) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
};

export const compareUpdateVersions = (left: string, right: string): number => {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error('Invalid update version.');
  }
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const difference = parsedLeft.core[index] - parsedRight.core[index];
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    return parsedLeft.prerelease.length === parsedRight.prerelease.length
      ? 0
      : parsedLeft.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Math.sign(Number(leftIdentifier) - Number(rightIdentifier));
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
};

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);

const isSafeInstallerName = (
  value: unknown,
  platform: UpdatePlatform,
): value is string => {
  if (
    typeof value !== 'string' ||
    path.basename(value) !== value ||
    !value.startsWith('SugarCode-') ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return false;
  }
  if (platform === 'win32-x64') {
    return value.endsWith('-windows-x64-Setup.exe');
  }
  return value.endsWith(
    platform === 'darwin-arm64' ? '-macos-arm64.dmg' : '-macos-x64.dmg',
  );
};

const parseManifest = (
  bytes: Buffer,
  platform: UpdatePlatform,
): UpdateManifest => {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isRecord(value) ||
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    typeof value.version !== 'string' ||
    !parseSemver(value.version) ||
    typeof value.publishedAt !== 'string' ||
    Number.isNaN(Date.parse(value.publishedAt)) ||
    (value.notes !== undefined && typeof value.notes !== 'string') ||
    !isRecord(value.platforms)
  ) {
    throw new Error('Invalid update manifest.');
  }
  const platformValue = value.platforms[platform];
  if (
    !isRecord(platformValue) ||
    !isSafeInstallerName(platformValue.file, platform) ||
    !Number.isSafeInteger(platformValue.size) ||
    Number(platformValue.size) <= 0 ||
    Number(platformValue.size) > MAX_INSTALLER_BYTES ||
    !isSha256(platformValue.sha256)
  ) {
    throw new Error('Invalid platform update manifest.');
  }
  return value as UpdateManifest;
};

const parseRelease = (value: unknown): GitHubRelease => {
  if (
    !isRecord(value) ||
    typeof value.tag_name !== 'string' ||
    typeof value.draft !== 'boolean' ||
    typeof value.prerelease !== 'boolean' ||
    !Array.isArray(value.assets) ||
    !value.assets.every(
      (asset) =>
        isRecord(asset) &&
        typeof asset.name === 'string' &&
        Number.isSafeInteger(asset.size) &&
        Number(asset.size) >= 0 &&
        typeof asset.browser_download_url === 'string',
    )
  ) {
    throw new Error('Invalid release response.');
  }
  return value as unknown as GitHubRelease;
};

const assertTrustedDownloadUrl = (value: string): URL => {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (host !== 'github.com' &&
      host !== 'api.github.com' &&
      !host.endsWith('.githubusercontent.com'))
  ) {
    throw new Error('Untrusted update URL.');
  }
  return url;
};

const sha256File = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const removeIfPresent = async (filePath: string): Promise<void> => {
  await rm(filePath, { force: true });
};

const replaceFile = async (temporary: string, destination: string): Promise<void> => {
  await removeIfPresent(destination);
  await rename(temporary, destination);
};

const readBoundedResponse = async (
  response: Response,
  maximumBytes: number,
): Promise<Buffer> => {
  if (!response.ok) {
    throw new Error('Update request failed.');
  }
  const declaredLengthHeader = response.headers.get('content-length');
  const declaredLength = Number(declaredLengthHeader);
  if (
    declaredLengthHeader !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    throw new Error('Update response is too large.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error('Update response is too large.');
  }
  return bytes;
};

const findAsset = (
  release: GitHubRelease,
  name: string,
): GitHubReleaseAsset => {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) {
    throw new Error('Release asset is missing.');
  }
  assertTrustedDownloadUrl(asset.browser_download_url);
  return asset;
};

const decodeSignature = (bytes: Buffer): Buffer => {
  const value = bytes.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Invalid update signature.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 64) {
    throw new Error('Invalid update signature.');
  }
  return decoded;
};

export class UpdateController {
  private readonly options: UpdateControllerOptions;
  private readonly listeners = new Set<Listener>();
  private readonly fetch: typeof fetch;
  private snapshot: UpdateStateSnapshot = { revision: 0, status: 'idle' };
  private pending: PendingUpdate | null = null;
  private checkPromise: Promise<void> | null = null;
  private failureCount = 0;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: UpdateControllerOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  getSnapshot = (): UpdateStateSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start = async (): Promise<void> => {
    if (!this.options.platform) {
      return;
    }
    await this.restorePending();
    if (this.stopped) {
      return;
    }
    this.initialTimer = setTimeout(() => {
      void this.checkNow();
    }, this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    this.intervalTimer = setInterval(() => {
      void this.checkNow();
    }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  };

  stop = (): void => {
    this.stopped = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.retryTimer = null;
    this.listeners.clear();
  };

  checkNow = async (): Promise<void> => {
    if (this.stopped || !this.options.platform) {
      return;
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }
    const task = this.performCheck();
    this.checkPromise = task;
    try {
      await task;
      this.failureCount = 0;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    } catch {
      this.handleFailure();
    } finally {
      if (this.checkPromise === task) {
        this.checkPromise = null;
      }
    }
  };

  install = async (): Promise<UpdateActionResult> => {
    const pending = this.pending;
    if (this.snapshot.status !== 'ready' || !pending) {
      return rejected('unavailable');
    }
    if (this.options.getInstallBlock()) {
      return rejected('busy');
    }
    try {
      await this.validatePending(pending);
      if (!(await this.options.launchInstaller(pending.installerPath))) {
        return rejected('failed');
      }
      this.options.quitApplication();
      return accepted();
    } catch {
      this.pending = null;
      await removeIfPresent(this.options.pendingStatePath).catch(
        (): undefined => undefined,
      );
      this.publish({ status: 'fallback' });
      return rejected('invalid');
    }
  };

  openDownloadPage = async (): Promise<UpdateActionResult> => {
    try {
      return (await this.options.openDownloadPage(this.options.downloadPageUrl))
        ? accepted()
        : rejected('failed');
    } catch {
      return rejected('failed');
    }
  };

  private performCheck = async (): Promise<void> => {
    const platform = this.options.platform;
    if (!platform || !this.options.publicKeyPem.trim()) {
      throw new Error('Update verification key is unavailable.');
    }
    if (!this.pending) {
      this.publish({ status: 'checking' });
    }
    const releaseResponse = await this.fetch(this.options.latestReleaseApiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    const release = parseRelease(await releaseResponse.json());
    if (!releaseResponse.ok || release.draft || release.prerelease) {
      throw new Error('Latest release is unavailable.');
    }

    const manifestAsset = findAsset(release, MANIFEST_NAME);
    const signatureAsset = findAsset(release, SIGNATURE_NAME);
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.downloadSmallAsset(manifestAsset, MAX_MANIFEST_BYTES),
      this.downloadSmallAsset(signatureAsset, MAX_SIGNATURE_BYTES),
    ]);
    this.verifyManifestSignature(manifestBytes, signatureBytes);
    const manifest = parseManifest(manifestBytes, platform);
    if (release.tag_name !== `v${manifest.version}`) {
      throw new Error('Release version does not match its manifest.');
    }
    if (compareUpdateVersions(manifest.version, this.options.currentVersion) <= 0) {
      if (!this.pending) {
        this.publish({ status: 'idle' });
      }
      return;
    }

    const platformUpdate = manifest.platforms[platform];
    const installerAsset = findAsset(release, platformUpdate.file);
    if (installerAsset.size !== platformUpdate.size) {
      throw new Error('Installer size does not match its manifest.');
    }
    this.publish({ status: 'downloading' });
    const installerPath = path.join(
      this.options.downloadsDirectory,
      platformUpdate.file,
    );
    await this.ensureInstaller(installerAsset, platformUpdate, installerPath);
    const pending: PendingUpdate = {
      version: manifest.version,
      installerPath,
      sha256: platformUpdate.sha256.toLowerCase(),
      size: platformUpdate.size,
      manifestBase64: manifestBytes.toString('base64'),
      signatureBase64: signatureBytes.toString('base64'),
    };
    await this.writePending(pending);
    this.pending = pending;
    this.publish({ status: 'ready', version: pending.version });
  };

  private downloadSmallAsset = async (
    asset: GitHubReleaseAsset,
    maximumBytes: number,
  ): Promise<Buffer> => {
    const response = await this.fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    assertTrustedDownloadUrl(response.url || asset.browser_download_url);
    return readBoundedResponse(response, maximumBytes);
  };

  private verifyManifestSignature = (
    manifestBytes: Buffer,
    signatureBytes: Buffer,
  ): void => {
    const publicKey = createPublicKey(this.options.publicKeyPem);
    if (
      !verifySignature(
        null,
        manifestBytes,
        publicKey,
        decodeSignature(signatureBytes),
      )
    ) {
      throw new Error('Update manifest signature verification failed.');
    }
  };

  private ensureInstaller = async (
    asset: GitHubReleaseAsset,
    expected: ManifestPlatform,
    installerPath: string,
  ): Promise<void> => {
    await mkdir(this.options.downloadsDirectory, { recursive: true });
    try {
      const metadata = await lstat(installerPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Installer path is unsafe.');
      }
      if (
        metadata.size === expected.size &&
        (await sha256File(installerPath)) === expected.sha256.toLowerCase()
      ) {
        return;
      }
      await removeIfPresent(installerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const partPath = `${installerPath}.part`;
    await removeIfPresent(partPath);
    let output: WriteStream | undefined;
    try {
      const response = await this.fetch(asset.browser_download_url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        throw new Error('Installer download failed.');
      }
      assertTrustedDownloadUrl(response.url || asset.browser_download_url);
      const declaredLengthHeader = response.headers.get('content-length');
      const declaredLength = Number(declaredLengthHeader);
      if (
        declaredLengthHeader !== null &&
        Number.isFinite(declaredLength) &&
        declaredLength !== expected.size
      ) {
        throw new Error('Installer download size is invalid.');
      }
      let downloaded = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.byteLength;
          callback(
            downloaded > expected.size
              ? new Error('Installer download exceeded its expected size.')
              : null,
            chunk,
          );
        },
      });
      output = createWriteStream(partPath, { flags: 'wx' });
      await pipeline(
        Readable.fromWeb(response.body as never),
        limiter,
        output,
      );
      if (downloaded !== expected.size) {
        throw new Error('Installer download is incomplete.');
      }
      if ((await sha256File(partPath)) !== expected.sha256.toLowerCase()) {
        throw new Error('Installer checksum verification failed.');
      }
      await replaceFile(partPath, installerPath);
    } catch (error) {
      output?.destroy();
      await removeIfPresent(partPath).catch((): undefined => undefined);
      throw error;
    }
  };

  private writePending = async (pending: PendingUpdate): Promise<void> => {
    const directory = path.dirname(this.options.pendingStatePath);
    const temporary = `${this.options.pendingStatePath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(pending, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await replaceFile(temporary, this.options.pendingStatePath);
  };

  private restorePending = async (): Promise<void> => {
    try {
      const value: unknown = JSON.parse(
        await readFile(this.options.pendingStatePath, 'utf8'),
      );
      if (!this.isPendingUpdate(value)) {
        throw new Error('Invalid pending update.');
      }
      await this.validatePending(value);
      this.pending = value;
      this.publish({ status: 'ready', version: value.version });
    } catch {
      this.pending = null;
      await removeIfPresent(this.options.pendingStatePath).catch(
        (): undefined => undefined,
      );
    }
  };

  private isPendingUpdate = (value: unknown): value is PendingUpdate =>
    isRecord(value) &&
    Object.keys(value).length === 6 &&
    typeof value.version === 'string' &&
    parseSemver(value.version) !== null &&
    typeof value.installerPath === 'string' &&
    isSha256(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    Number(value.size) <= MAX_INSTALLER_BYTES &&
    typeof value.manifestBase64 === 'string' &&
    typeof value.signatureBase64 === 'string';

  private validatePending = async (pending: PendingUpdate): Promise<void> => {
    const platform = this.options.platform;
    if (!platform || compareUpdateVersions(pending.version, this.options.currentVersion) <= 0) {
      throw new Error('Pending update is not newer than this application.');
    }
    const manifestBytes = Buffer.from(pending.manifestBase64, 'base64');
    const signatureBytes = Buffer.from(pending.signatureBase64, 'base64');
    if (
      manifestBytes.byteLength === 0 ||
      manifestBytes.byteLength > MAX_MANIFEST_BYTES ||
      signatureBytes.byteLength === 0 ||
      signatureBytes.byteLength > MAX_SIGNATURE_BYTES
    ) {
      throw new Error('Pending update verification data is invalid.');
    }
    this.verifyManifestSignature(manifestBytes, signatureBytes);
    const manifest = parseManifest(manifestBytes, platform);
    const expected = manifest.platforms[platform];
    if (
      manifest.version !== pending.version ||
      path.join(this.options.downloadsDirectory, expected.file) !== pending.installerPath ||
      expected.sha256.toLowerCase() !== pending.sha256.toLowerCase() ||
      expected.size !== pending.size
    ) {
      throw new Error('Pending update does not match its manifest.');
    }
    const metadata = await lstat(pending.installerPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size !== pending.size ||
      (await sha256File(pending.installerPath)) !== pending.sha256.toLowerCase()
    ) {
      throw new Error('Pending installer is invalid.');
    }
  };

  private handleFailure = (): void => {
    if (this.pending) {
      this.publish({ status: 'ready', version: this.pending.version });
      return;
    }
    this.failureCount += 1;
    const retryDelays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const retryDelay = retryDelays[this.failureCount - 1];
    if (retryDelay !== undefined) {
      this.publish({ status: 'idle' });
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.checkNow();
      }, retryDelay);
      return;
    }
    this.publish({ status: 'fallback' });
  };

  private publish = (
    state: Omit<UpdateStateSnapshot, 'revision'>,
  ): void => {
    this.snapshot = { revision: this.snapshot.revision + 1, ...state };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  };
}
