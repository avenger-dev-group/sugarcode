import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAbsoluteWorkspaceFileReference } from '../../../src/main/workspace/file-reference.ts';

test('absolute POSIX citations resolve only beneath the canonical project root', () => {
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      '/Users/simonf/My Project',
      '/Users/simonf/My Project/src/components/sidebar.tsx',
    ),
    {
      status: 'resolved',
      path: 'src/components/sidebar.tsx',
    },
  );
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      '/Users/simonf/My Project',
      '/Users/simonf/Other Project/src/components/sidebar.tsx',
    ),
    { status: 'outsideWorkspace' },
  );
});

test('absolute Windows citations resolve case-insensitively beneath their project root', () => {
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      'D:\\Project',
      'd:\\project\\src\\components\\sidebar.tsx',
    ),
    {
      status: 'resolved',
      path: 'src/components/sidebar.tsx',
    },
  );
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      'D:\\Project',
      'D:\\Project-Other\\src\\components\\sidebar.tsx',
    ),
    { status: 'outsideWorkspace' },
  );
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      '\\\\server\\share\\Project',
      '//server/share/Project/src/sidebar.tsx',
    ),
    {
      status: 'resolved',
      path: 'src/sidebar.tsx',
    },
  );
});

test('absolute citations reject traversal and cross-platform roots', () => {
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      '/Users/simonf/project',
      '/Users/simonf/project/src/../outside.ts',
    ),
    { status: 'outsideWorkspace' },
  );
  assert.deepEqual(
    resolveAbsoluteWorkspaceFileReference(
      '/Users/simonf/project',
      'D:\\project\\src\\sidebar.tsx',
    ),
    { status: 'outsideWorkspace' },
  );
});
