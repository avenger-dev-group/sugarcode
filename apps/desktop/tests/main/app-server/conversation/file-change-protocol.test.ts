import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWorkspaceApplyPatchPaths } from '../../../../src/main/app-server/conversation/workspace-apply-patch.ts';

const isValidPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.split('/').includes('..');

const patch = [
  '*** Begin Patch',
  '*** Add File: src/added.ts',
  '+export const added = true;',
  '*** Update File: src/current.ts',
  '@@',
  '-export const current = false;',
  '+export const current = true;',
  '*** End Patch',
].join('\n');

test('freeform workspace patches recover authoritative marker paths', () => {
  assert.deepEqual(
    parseWorkspaceApplyPatchPaths(patch, isValidPath),
    ['src/added.ts', 'src/current.ts'],
  );
});

test('JSON-only provider fallback uses the same patch projection', () => {
  assert.deepEqual(
    parseWorkspaceApplyPatchPaths({ patch }, isValidPath),
    ['src/added.ts', 'src/current.ts'],
  );
});

test('malformed boundaries, duplicate paths and traversal fail recovery', () => {
  for (const invalidPatch of [
    patch.replace('*** Begin Patch\n', ''),
    patch.replace('*** Update File: src/current.ts', '*** Update File: src/added.ts'),
    patch.replace('src/current.ts', '../outside.ts'),
  ]) {
    assert.throws(() =>
      parseWorkspaceApplyPatchPaths(invalidPatch, isValidPath),
    );
  }
});
