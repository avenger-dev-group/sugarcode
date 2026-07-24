import {
  PROTOCOL_VERSION,
  SUGARCODE_PRODUCT_VERSION,
} from '@sugarcode/app-server-protocol';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getPackagedResourcesPath,
  smokePackagedSidecar,
  type SidecarManifest,
} from '../packaged-sidecar';
import {
  getCliTarget,
  requireNativeCliTarget,
} from '../../src/main/app-server/cli-platform';

type PreparedSidecar = Parameters<typeof smokePackagedSidecar>[0];
type PackageResult = Parameters<typeof smokePackagedSidecar>[1];

const temporaryRoots: string[] = [];

const createPackagedFixture = async (): Promise<{
  executablePath: string;
  manifestPath: string;
  packageResult: PackageResult;
  prepared: PreparedSidecar;
  resourceDirectory: string;
  resourcesPath: string;
}> => {
  const target = getCliTarget(process.platform, process.arch);
  if (!target) {
    throw new Error('Tests require a supported native CLI target.');
  }
  const outputPath = await mkdtemp(
    path.join(tmpdir(), 'sugarcode-package-test-'),
  );
  temporaryRoots.push(outputPath);
  const resourcesPath = getPackagedResourcesPath(
    outputPath,
    target.platform,
    'SugarCode',
  );
  const resourceDirectory = path.join(resourcesPath, 'sugarcode-sidecar');
  const executablePath = path.join(
    resourceDirectory,
    'bin',
    target.executableName,
  );
  const manifest: SidecarManifest = {
    schemaVersion: 1,
    productVersion: SUGARCODE_PRODUCT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: target.platform,
    arch: target.arch,
    targetTriple: target.rustTriple,
    executable: path.posix.join('bin', target.executableName),
    sha256: '0'.repeat(64),
  };
  return {
    executablePath,
    manifestPath: path.join(resourceDirectory, 'manifest.json'),
    packageResult: {
      arch: target.arch,
      outputPaths: [outputPath],
      platform: target.platform,
    },
    prepared: {
      manifest,
      productName: 'SugarCode',
      resourceDirectory: path.join(outputPath, 'staged-sidecar'),
      sourceExecutablePath: path.join(outputPath, 'built-sugarcode'),
      target,
      temporaryRoot: path.join(outputPath, 'temporary-sidecar'),
    },
    resourceDirectory,
    resourcesPath,
  };
};

const writeManifest = async (
  manifestPath: string,
  manifest: SidecarManifest,
): Promise<void> => {
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
};

const writeAppAsar = async (resourcesPath: string): Promise<void> => {
  await mkdir(resourcesPath, { recursive: true });
  await writeFile(path.join(resourcesPath, 'app.asar'), 'test asar');
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe('packaged CLI target mapping', () => {
  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'sugarcode'],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'sugarcode'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'sugarcode'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'sugarcode'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'sugarcode.exe'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'sugarcode.exe'],
  ] as const)(
    'maps %s/%s to one Rust target',
    (platform, arch, rustTriple, executableName) => {
      expect(getCliTarget(platform, arch)).toMatchObject({
        platform,
        arch,
        rustTriple,
        executableName,
      });
    },
  );

  it.each([
    ['mas', 'arm64'],
    ['darwin', 'universal'],
    ['linux', 'ia32'],
    ['freebsd', 'x64'],
  ])('rejects unsupported target %s/%s', (platform, arch) => {
    expect(() =>
      requireNativeCliTarget(
        platform,
        arch,
        'darwin',
        'arm64',
      ),
    ).toThrow('Unsupported packaged CLI target');
  });

  it.each([
    ['linux', 'arm64', 'darwin', 'arm64'],
    ['darwin', 'x64', 'darwin', 'arm64'],
  ] as const)(
    'rejects native target %s/%s on host %s/%s before Cargo runs',
    (platform, arch, hostPlatform, hostArch) => {
      expect(() =>
        requireNativeCliTarget(platform, arch, hostPlatform, hostArch),
      ).toThrow('Cross-target packaged CLI builds are unsupported');
    },
  );
});

describe('packaged resources layout', () => {
  it('uses the macOS app bundle Resources directory', () => {
    expect(
      getPackagedResourcesPath(
        '/out/SugarCode-darwin-arm64',
        'darwin',
        'SugarCode',
      ),
    ).toBe(
      path.join(
        '/out/SugarCode-darwin-arm64',
        'SugarCode.app',
        'Contents',
        'Resources',
      ),
    );
  });

  it.each(['linux', 'win32'])(
    'uses the top-level resources directory on %s',
    (platform) => {
      expect(
        getPackagedResourcesPath('/out/SugarCode-target', platform, 'SugarCode'),
      ).toBe(path.join('/out/SugarCode-target', 'resources'));
    },
  );

  it('rejects an unsupported package output platform', () => {
    expect(() =>
      getPackagedResourcesPath('/out/SugarCode-mas-arm64', 'mas', 'SugarCode'),
    ).toThrow('Unsupported package output platform');
  });

  it('rejects an unexpected Forge target or output path count', async () => {
    const fixture = await createPackagedFixture();
    const wrongArch =
      fixture.packageResult.arch === 'arm64' ? 'x64' : 'arm64';

    await expect(
      smokePackagedSidecar(fixture.prepared, {
        ...fixture.packageResult,
        outputPaths: [],
      }),
    ).rejects.toThrow('Forge returned an unexpected package target');
    await expect(
      smokePackagedSidecar(fixture.prepared, {
        ...fixture.packageResult,
        arch: wrongArch,
      }),
    ).rejects.toThrow('Forge returned an unexpected package target');
  });

  it('rejects a package with no app.asar', async () => {
    const fixture = await createPackagedFixture();

    await expect(
      smokePackagedSidecar(fixture.prepared, fixture.packageResult),
    ).rejects.toThrow();
  });

  it('rejects a package that omitted the sidecar resource', async () => {
    const fixture = await createPackagedFixture();
    await writeAppAsar(fixture.resourcesPath);

    await expect(
      smokePackagedSidecar(fixture.prepared, fixture.packageResult),
    ).rejects.toThrow();
  });

  it('rejects a changed packaged manifest', async () => {
    const fixture = await createPackagedFixture();
    await writeAppAsar(fixture.resourcesPath);
    await mkdir(path.dirname(fixture.executablePath), { recursive: true });
    await writeManifest(fixture.manifestPath, {
      ...fixture.prepared.manifest,
      productVersion: '9.9.9',
    });

    await expect(
      smokePackagedSidecar(fixture.prepared, fixture.packageResult),
    ).rejects.toThrow('manifest changed during packaging');
  });

  it('rejects a sidecar with more than one executable', async () => {
    const fixture = await createPackagedFixture();
    await writeAppAsar(fixture.resourcesPath);
    await mkdir(path.dirname(fixture.executablePath), { recursive: true });
    await Promise.all([
      writeFile(fixture.executablePath, 'first executable'),
      writeFile(
        path.join(path.dirname(fixture.executablePath), 'unexpected'),
        'second executable',
      ),
      writeManifest(fixture.manifestPath, fixture.prepared.manifest),
    ]);

    await expect(
      smokePackagedSidecar(fixture.prepared, fixture.packageResult),
    ).rejects.toThrow('must contain one exact executable');
  });

  it('rejects a packaged executable with the wrong SHA-256', async () => {
    const fixture = await createPackagedFixture();
    await writeAppAsar(fixture.resourcesPath);
    await mkdir(path.dirname(fixture.executablePath), { recursive: true });
    await Promise.all([
      writeFile(fixture.executablePath, 'hash mismatch'),
      writeManifest(fixture.manifestPath, fixture.prepared.manifest),
    ]);
    if (fixture.prepared.target.platform !== 'win32') {
      await chmod(fixture.executablePath, 0o755);
    }

    await expect(
      smokePackagedSidecar(fixture.prepared, fixture.packageResult),
    ).rejects.toThrow('does not match the verified build');
  });
});
