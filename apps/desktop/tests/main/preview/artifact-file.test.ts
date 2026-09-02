import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolvePreviewArtifact } from '../../../src/main/preview/artifact-file.ts';
import type { WorkspaceLaunchContext } from '../../../src/main/workspace/controller.ts';

test('HTML and video artifacts resolve directly to their local file URL', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-artifact-'));
  const entry = path.join(workspace, 'index.html');
  await writeFile(entry, '<h1>SugarCode</h1>');
  try {
    const realWorkspace = await realpath(workspace);
    const realEntry = await realpath(entry);
    const artifact = await resolvePreviewArtifact(
      {
        generation: 7,
        workspaceId: 'workspace',
        path: workspace,
        name: 'fixture',
        threadId: null,
      },
      'index.html',
    );
    assert.deepEqual(artifact, {
      absolutePath: realEntry,
      root: realWorkspace,
      url: pathToFileURL(realEntry).toString(),
    });
    assert.equal(new URL(artifact.url).protocol, 'file:');
    const videoEntry = path.join(workspace, 'final.mp4');
    await writeFile(videoEntry, 'video');
    const videoArtifact = await resolvePreviewArtifact(
      {
        generation: 7,
        workspaceId: 'workspace',
        path: workspace,
        name: 'fixture',
        threadId: null,
      },
      'final.mp4',
    );
    assert.equal(videoArtifact?.absolutePath, await realpath(videoEntry));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('preview artifact resolution rejects unsupported files and escaping symlinks', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-artifact-'));
  const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), 'sugarcode-outside-'));
  const outside = path.join(outsideDirectory, 'outside.html');
  await writeFile(path.join(workspace, 'notes.txt'), 'not an entry');
  await writeFile(outside, '<h1>Outside</h1>');
  await symlink(outside, path.join(workspace, 'outside.html'));
  const context: WorkspaceLaunchContext = {
    generation: 1,
    workspaceId: 'workspace',
    path: workspace,
    name: 'fixture',
    threadId: null,
  };
  try {
    assert.equal(await resolvePreviewArtifact(context, 'notes.txt'), null);
    assert.equal(await resolvePreviewArtifact(context, '../outside.html'), null);
    assert.equal(await resolvePreviewArtifact(context, 'outside.html'), null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});
