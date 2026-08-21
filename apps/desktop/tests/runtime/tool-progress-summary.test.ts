import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toolProgressSummary,
  toolResultSummary,
} from '../../src/runtime/tool-progress-summary.ts';

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

test('Skill progress uses its dedicated activity instead of synthesized text', () => {
  assert.equal(
    toolProgressSummary('请使用 Skill', 'load_skill', { name: 'code-review' }),
    undefined,
  );
});

test('image analysis has a localized progress summary', () => {
  assert.equal(
    toolProgressSummary('分析这张图片', 'analyze_image', {
      assetId: `ast_${'a'.repeat(64)}`,
    }),
    '正在分析图片内容。',
  );
});

test('video analysis progress explains the selected processing path', () => {
  assert.equal(
    toolProgressSummary('分析这个会议视频', 'analyze_video', {
      assetId: `ast_${'a'.repeat(64)}`,
      mode: 'meeting',
    }),
    '正在分析完整视频、转写音轨并区分说话人。',
  );
  assert.equal(
    toolProgressSummary('Analyze this video', 'analyze_video', {
      assetId: `ast_${'a'.repeat(64)}`,
      mode: 'native',
    }),
    'Analyzing the complete video with the configured model’s native video capability.',
  );
});

test('video analysis result reports the actual transport and audio path', () => {
  assert.equal(
    toolResultSummary('分析这个会议视频', 'analyze_video', {
      ok: true,
      transport: 'hybrid',
      nativeSource: 'temporaryUrl',
      speakerCount: 2,
    }),
    '视频分析已完成：原生视频 + 独立音轨转写，识别 2 位说话人。',
  );
  assert.equal(
    toolResultSummary('Analyze this video', 'analyze_video', {
      ok: true,
      transport: 'extractedFrames',
    }),
    'Video analysis completed with extracted frames because native video was unavailable; no usable audio transcript was obtained.',
  );
});
