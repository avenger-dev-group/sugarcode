import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveVerifiedWorkspaceFileReference,
  toWorkspaceFileReference,
} from '../../../src/renderer/components/workspace/file-reference.ts';

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

test('workspace file references preserve absolute citations for trusted resolution', () => {
  assert.equal(
    toWorkspaceFileReference(
      '/Users/simonf/My Project/src/components/sidebar.tsx:42',
    ),
    '/Users/simonf/My Project/src/components/sidebar.tsx',
  );
  assert.equal(
    toWorkspaceFileReference(
      '/Users/simonf/My%20Project/src/components/sidebar.tsx',
    ),
    '/Users/simonf/My Project/src/components/sidebar.tsx',
  );
  assert.equal(
    toWorkspaceFileReference('D:\\project\\src\\components\\sidebar.tsx#L18'),
    'D:\\project\\src\\components\\sidebar.tsx',
  );
});

test('workspace file references reject URLs and unsafe paths', () => {
  assert.equal(toWorkspaceFileReference('https://example.com/file.ts'), null);
  assert.equal(toWorkspaceFileReference('../outside.ts'), null);
  assert.equal(toWorkspaceFileReference('/project/../outside/file.ts'), null);
  assert.equal(toWorkspaceFileReference('not a file'), null);
  assert.equal(toWorkspaceFileReference('configuration'), null);
});

test('code spans resolve only through one verified workspace path', () => {
  const verifiedPaths = [
    'src/components/data-table/utils.ts',
    'src/pages/call-management/call-record/utils.ts',
    'src/pages/organization-management/company/use-store.ts',
    'src/components/layout/components/progress-bar.tsx',
  ];

  assert.equal(
    resolveVerifiedWorkspaceFileReference(
      'company/use-store.ts',
      verifiedPaths,
    ),
    'src/pages/organization-management/company/use-store.ts',
  );
  assert.equal(
    resolveVerifiedWorkspaceFileReference('progress-bar.tsx', verifiedPaths),
    'src/components/layout/components/progress-bar.tsx',
  );
  assert.equal(
    resolveVerifiedWorkspaceFileReference('utils.ts', verifiedPaths),
    null,
  );
  assert.equal(
    resolveVerifiedWorkspaceFileReference('[navigation.state]', verifiedPaths),
    null,
  );
  assert.equal(
    resolveVerifiedWorkspaceFileReference('[location.pathname]', verifiedPaths),
    null,
  );
  assert.equal(
    resolveVerifiedWorkspaceFileReference(
      '@stylistic/jsx-one-expression-per-line',
      verifiedPaths,
    ),
    null,
  );
});

test('code spans stay ordinary code without verified file evidence', () => {
  assert.equal(
    resolveVerifiedWorkspaceFileReference('extension.tsx', []),
    null,
  );
  assert.equal(
    resolveVerifiedWorkspaceFileReference('scripts/release', [
      'scripts/release',
    ]),
    null,
  );
});
