import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUpdateManifest } from '../create-update-manifest.mjs';

test('creates a signed manifest for every desktop release artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-manifest-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyBase64 = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ).toString('base64');
  const publicKeyBase64 = Buffer.from(
    publicKey.export({ type: 'spki', format: 'pem' }),
  ).toString('base64');
  try {
    await Promise.all([
      writeFile(path.join(directory, 'SugarCode-3.1.0-macos-arm64.dmg'), 'arm'),
      writeFile(path.join(directory, 'SugarCode-3.1.0-macos-x64.dmg'), 'intel'),
      writeFile(path.join(directory, 'SugarCode-3.1.0-windows-x64-Setup.exe'), 'win'),
    ]);
    await createUpdateManifest({
      version: '3.1.0',
      assetsDirectory: directory,
      privateKeyBase64,
      publicKeyBase64,
      publishedAt: '2026-08-12T00:00:00.000Z',
    });
    const manifestBytes = await readFile(
      path.join(directory, 'update-manifest.json'),
    );
    const signature = Buffer.from(
      (await readFile(path.join(directory, 'update-manifest.sig'), 'utf8')).trim(),
      'base64',
    );
    assert.equal(
      verify(null, manifestBytes, publicKey, signature),
      true,
    );
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.platforms['win32-x64'].size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
