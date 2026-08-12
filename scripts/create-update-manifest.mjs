import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { decodeUpdatePublicKey } from './verify-update-signing-key.mjs';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const normalizePem = (value) => value.trim().replaceAll('\r\n', '\n');

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
  privateKeyBase64,
  publicKeyBase64,
  notes = '',
  publishedAt = new Date().toISOString(),
}) => {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error('A valid SemVer release version is required.');
  }
  const privateKeyPem = Buffer.from(privateKeyBase64 ?? '', 'base64').toString(
    'utf8',
  );
  if (!privateKeyPem.trim()) {
    throw new Error('SUGARCODE_UPDATE_PRIVATE_KEY_B64 is required.');
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The update private key must be an Ed25519 key.');
  }
  const configuredPublicKeyPem = decodeUpdatePublicKey(publicKeyBase64);
  const derivedPublicKeyPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  if (normalizePem(derivedPublicKeyPem) !== normalizePem(configuredPublicKeyPem)) {
    throw new Error('The configured update signing keys do not match.');
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
  const signature = sign(null, manifestBytes, privateKey).toString('base64');
  await Promise.all([
    writeFile(path.join(assetsDirectory, 'update-manifest.json'), manifestBytes),
    writeFile(path.join(assetsDirectory, 'update-manifest.sig'), `${signature}\n`),
  ]);
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
    privateKeyBase64: process.env.SUGARCODE_UPDATE_PRIVATE_KEY_B64,
    publicKeyBase64: process.env.SUGARCODE_UPDATE_PUBLIC_KEY_B64,
    notes: process.env.RELEASE_NOTES ?? '',
  });
  const manifest = JSON.parse(
    await readFile(path.resolve(assetsArgument, 'update-manifest.json'), 'utf8'),
  );
  console.log(`Created signed update manifest for v${manifest.version}.`);
}
