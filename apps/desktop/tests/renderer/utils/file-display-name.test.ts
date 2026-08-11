import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShortestUniquePathLabels,
  fileBasename,
} from '../../../src/renderer/utils/file-display-name.ts';

test('file display names use basenames until a collision needs more context', () => {
  const paths = [
    'src/pages/call-record/use-store.ts',
    'src/pages/contacts/use-store.ts',
    'src/components/layout/sidebar.tsx',
  ];
  const labels = createShortestUniquePathLabels(paths);

  assert.equal(labels.get(paths[0]), 'call-record/use-store.ts');
  assert.equal(labels.get(paths[1]), 'contacts/use-store.ts');
  assert.equal(labels.get(paths[2]), 'sidebar.tsx');
  assert.equal(fileBasename('src\\pages\\login\\login.tsx'), 'login.tsx');
});

test('repeated references to one path keep one compact label', () => {
  const path = 'src/components/data-table/utils.ts';
  const labels = createShortestUniquePathLabels([path, path]);

  assert.equal(labels.size, 1);
  assert.equal(labels.get(path), 'utils.ts');
});
