import assert from 'node:assert/strict';
import test from 'node:test';

import { toolProgressSummary } from '../../src/runtime/tool-progress-summary.ts';

test('workspace read progress uses compact basenames for a small batch', () => {
  assert.equal(
    toolProgressSummary('审查项目', 'workspace_read', {
      paths: [
        'src/components/layout/components/sidebar/sidebar.tsx',
        'src/components/layout/components/sidebar/nav-main.tsx',
        'src/components/layout/components/sidebar/nav-user.tsx',
      ],
    }),
    '正在读取 sidebar.tsx、nav-main.tsx、nav-user.tsx。',
  );
});

test('workspace read progress collapses a large batch to its count', () => {
  const paths = Array.from({ length: 8 }, (_, index) =>
    `src/pages/example-${index}.tsx`,
  );

  assert.equal(
    toolProgressSummary('审查项目', 'workspace_read', { paths }),
    '正在读取 8 个项目文件。',
  );
  assert.equal(
    toolProgressSummary('Review the project', 'workspace_read', { paths }),
    'Reading 8 project files.',
  );
});

test('Skill progress discloses only the bounded selected name', () => {
  assert.equal(
    toolProgressSummary('请使用 Skill', 'load_skill', { name: 'code-review' }),
    '正在加载 Skill：code-review。',
  );
  assert.equal(
    toolProgressSummary('Use a Skill', 'load_skill', { name: null }),
    'Loading a Skill.',
  );
});
