import assert from 'node:assert/strict';
import test from 'node:test';

import { toWorkspaceFileReference } from '../../../src/renderer/components/workspace/file-reference.ts';

test('workspace file references accept bounded relative source paths', () => {
  assert.equal(
    toWorkspaceFileReference('apps/desktop/src/runtime/host.ts:42'),
    'apps/desktop/src/runtime/host.ts',
  );
  assert.equal(toWorkspaceFileReference('./README.md'), 'README.md');
  assert.equal(toWorkspaceFileReference('.env'), '.env');
  assert.equal(toWorkspaceFileReference('Dockerfile'), 'Dockerfile');
  assert.equal(toWorkspaceFileReference('scripts/release'), 'scripts/release');
  assert.equal(
    toWorkspaceFileReference('src/components/thread-view.tsx#L18-L24'),
    'src/components/thread-view.tsx',
  );
});

test('workspace file references reject URLs and unsafe paths', () => {
  assert.equal(toWorkspaceFileReference('https://example.com/file.ts'), null);
  assert.equal(toWorkspaceFileReference('../outside.ts'), null);
  assert.equal(toWorkspaceFileReference('/absolute/file.ts'), null);
  assert.equal(toWorkspaceFileReference('not a file'), null);
  assert.equal(toWorkspaceFileReference('configuration'), null);
});
