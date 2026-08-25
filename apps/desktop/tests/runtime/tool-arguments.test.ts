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

test('workspace_list repairs one bounded concatenated path batch', () => {
  assert.deepEqual(
    normalizeToolArguments(
      'workspace_list',
      '{"path":"app"}{"path":"routes"}{"path":"database"}',
    ),
    {
      name: 'workspace_list',
      args: { paths: ['app', 'routes', 'database'] },
    },
  );
});

test('workspace_list rejects an ambiguous concatenated argument batch', () => {
  assert.deepEqual(
    normalizeToolArguments(
      'workspace_list',
      '{"path":"app"}{"path":"routes","depth":2}',
    ),
    {
      name: 'sugarcode_invalid_tool_arguments',
      args: {
        toolName: 'workspace_list',
        argumentsText: '{"path":"app"}{"path":"routes","depth":2}',
      },
    },
  );
});

test('collaboration_dispatch repairs one bounded string-encoded tasks array', () => {
  const tasks = [{
    clientTaskKey: 'implementation',
    title: 'Implement',
    role: 'worker',
    taskMarkdown: 'Implement the requested change.',
  }];
  assert.deepEqual(
    normalizeToolArguments(
      'collaboration_dispatch',
      JSON.stringify({ tasks: JSON.stringify(tasks) }),
    ),
    {
      name: 'collaboration_dispatch',
      args: { tasks },
    },
  );
});

test('collaboration_dispatch preserves an invalid string-encoded tasks value', () => {
  assert.deepEqual(
    normalizeToolArguments(
      'collaboration_dispatch',
      JSON.stringify({ tasks: '{not json' }),
    ),
    {
      name: 'collaboration_dispatch',
      args: { tasks: '{not json' },
    },
  );
});
