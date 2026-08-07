import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeToolArguments } from '../../src/runtime/models/tool-arguments.ts';

test('workspace_read repairs one bounded string-encoded paths array', () => {
  assert.deepEqual(
    normalizeToolArguments(
      'workspace_read',
      JSON.stringify({
        paths: JSON.stringify([
          'README.md',
          'package.json',
          'src/main.tsx',
        ]),
      }),
    ),
    {
      name: 'workspace_read',
      args: {
        paths: ['README.md', 'package.json', 'src/main.tsx'],
      },
    },
  );
});

test('workspace_read does not truncate an oversized string-encoded batch', () => {
  const encodedPaths = JSON.stringify(
    Array.from({ length: 9 }, (_, index) => `file-${index}.txt`),
  );
  assert.deepEqual(
    normalizeToolArguments(
      'workspace_read',
      JSON.stringify({ paths: encodedPaths }),
    ),
    {
      name: 'workspace_read',
      args: { paths: encodedPaths },
    },
  );
});

test('tool argument compatibility repair never changes unrelated tools', () => {
  assert.deepEqual(
    normalizeToolArguments(
      'workspace_list',
      JSON.stringify({ paths: JSON.stringify(['src']) }),
    ),
    {
      name: 'workspace_list',
      args: { paths: JSON.stringify(['src']) },
    },
  );
});
