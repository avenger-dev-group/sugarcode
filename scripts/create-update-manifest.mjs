import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

export const createUpdateManifest = async ({
  version,
  assetsDirectory,
  notes = '',
  publishedAt = new Date().toISOString(),
}) => {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error('A valid SemVer release version is required.');
  }
  const files = {
    'darwin-arm64': `SugarCode-${version}-macos-arm64.dmg`,
    'darwin-x64': `SugarCode-${version}-macos-x64.dmg`,
    'win32-x64': `SugarCode-${version}-windows-x64-Setup.exe`,
  };
  const platforms = {};
  for (const [platform, file] of Object.entries(files)) {
    const filePath = path.join(assetsDirectory, file);
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size <= 0) {
      throw new Error(`Release asset is invalid: ${file}`);
    }
    platforms[platform] = {
      file,
      size: metadata.size,
      sha256: await sha256File(filePath),
    };
  }
  const manifest = {
    schemaVersion: 1,
    version,
    publishedAt,
    ...(notes.trim() ? { notes } : {}),
    platforms,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    path.join(assetsDirectory, 'update-manifest.json'),
    manifestBytes,
  );
  return manifest;
};

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  const [version, assetsArgument = 'release-assets'] = process.argv.slice(2);
  await createUpdateManifest({
    version,
    assetsDirectory: path.resolve(assetsArgument),
    notes: process.env.RELEASE_NOTES ?? '',
  });
  const manifest = JSON.parse(
    await readFile(path.resolve(assetsArgument, 'update-manifest.json'), 'utf8'),
  );
  console.log(`Created update manifest for v${manifest.version}.`);
}
