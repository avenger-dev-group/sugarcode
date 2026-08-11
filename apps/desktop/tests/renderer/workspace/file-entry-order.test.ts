import assert from 'node:assert/strict';
import test from 'node:test';

import { orderWorkspaceEntries } from '../../../src/renderer/components/workspace/workbench/file-entry-order.ts';
import type { WorkspaceEntry } from '../../../src/shared/workspace.ts';

const entry = (
  name: string,
  kind: WorkspaceEntry['kind'],
): WorkspaceEntry => ({
  name,
  kind,
  path: name,
});

test('workspace explorer groups folders before files and special entries', () => {
  const ordered = orderWorkspaceEntries([
    entry('alpha-link', 'link'),
    entry('alpha-file', 'file'),
    entry('zeta-folder', 'directory'),
    entry('alpha-other', 'other'),
    entry('alpha-folder', 'directory'),
  ]);

  assert.deepEqual(
    ordered.map(({ name }) => name),
    [
      'alpha-folder',
      'zeta-folder',
      'alpha-file',
      'alpha-link',
      'alpha-other',
    ],
  );
});

test('workspace explorer uses case-insensitive natural filename order', () => {
  const ordered = orderWorkspaceEntries([
    entry('file10.ts', 'file'),
    entry('Zoo.ts', 'file'),
    entry('file2.ts', 'file'),
    entry('alpha.ts', 'file'),
  ]);

  assert.deepEqual(
    ordered.map(({ name }) => name),
    ['alpha.ts', 'file2.ts', 'file10.ts', 'Zoo.ts'],
  );
});

test('workspace explorer ordering does not mutate the runtime result', () => {
  const original = [
    entry('zeta.ts', 'file'),
    entry('alpha.ts', 'file'),
  ];

  const ordered = orderWorkspaceEntries(original);

  assert.deepEqual(
    original.map(({ name }) => name),
    ['zeta.ts', 'alpha.ts'],
  );
  assert.notEqual(ordered, original);
});
