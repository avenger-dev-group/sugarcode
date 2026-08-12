import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUpdateManifest } from '../create-update-manifest.mjs';

test('creates a manifest for every desktop release artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-manifest-'));
  try {
    await Promise.all([
      writeFile(path.join(directory, 'SugarCode-3.1.0-macos-arm64.dmg'), 'arm'),
      writeFile(path.join(directory, 'SugarCode-3.1.0-macos-x64.dmg'), 'intel'),
      writeFile(path.join(directory, 'SugarCode-3.1.0-windows-x64-Setup.exe'), 'win'),
    ]);
    await createUpdateManifest({
      version: '3.1.0',
      assetsDirectory: directory,
      publishedAt: '2026-08-12T00:00:00.000Z',
    });
    const manifestBytes = await readFile(
      path.join(directory, 'update-manifest.json'),
    );
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.platforms['win32-x64'].size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
