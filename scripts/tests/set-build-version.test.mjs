import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setBuildVersion } from '../set-build-version.mjs';

test('synchronizes JavaScript and Rust build versions', async (context) => {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'sugarcode-build-version-'),
  );
  context.after(() => rm(workspaceRoot, { force: true, recursive: true }));
  await mkdir(path.join(workspaceRoot, 'apps', 'desktop'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'package.json'),
    '{"name":"sugarcode","version":"3.0.0"}\n',
  );
  await writeFile(
    path.join(workspaceRoot, 'apps', 'desktop', 'package.json'),
    '{"name":"@sugarcode/desktop","version":"3.0.0"}\n',
  );
  await writeFile(
    path.join(workspaceRoot, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "3.0.0"\nedition = "2024"\n',
  );
  await writeFile(
    path.join(workspaceRoot, 'Cargo.lock'),
    '[[package]]\nname = "external"\nversion = "1.0.0"\n\n[[package]]\nname = "sugarcode-desktop-native"\nversion = "3.0.0"\n\n[[package]]\nname = "sugarcode-tools"\nversion = "3.0.0"\n',
  );

  await setBuildVersion(workspaceRoot, '3.0.1');

  assert.equal(
    JSON.parse(await readFile(path.join(workspaceRoot, 'package.json')))
      .version,
    '3.0.1',
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(workspaceRoot, 'apps', 'desktop', 'package.json'),
      ),
    ).version,
    '3.0.1',
  );
  assert.match(
    await readFile(path.join(workspaceRoot, 'Cargo.toml'), 'utf8'),
    /\[workspace\.package\]\nversion = "3\.0\.1"/,
  );
  assert.equal(
    (await readFile(path.join(workspaceRoot, 'Cargo.lock'), 'utf8')).match(
      /version = "3\.0\.1"/g,
    )?.length,
    2,
  );
});

test('rejects a leading v and invalid numeric prerelease identifiers', async () => {
  await assert.rejects(
    setBuildVersion('/unused', 'v3.0.1'),
    /without a leading v/,
  );
  await assert.rejects(
    setBuildVersion('/unused', '3.0.1-beta.01'),
    /leading zero/,
  );
});

test('rejects a version older than the current Desktop version', async (context) => {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'sugarcode-build-version-'),
  );
  context.after(() => rm(workspaceRoot, { force: true, recursive: true }));
  await mkdir(path.join(workspaceRoot, 'apps', 'desktop'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'package.json'),
    '{"name":"sugarcode","version":"3.0.1"}\n',
  );
  await writeFile(
    path.join(workspaceRoot, 'apps', 'desktop', 'package.json'),
    '{"name":"@sugarcode/desktop","version":"3.0.1"}\n',
  );

  await assert.rejects(
    setBuildVersion(workspaceRoot, '3.0.0'),
    /older than the current project version 3\.0\.1/,
  );
});
