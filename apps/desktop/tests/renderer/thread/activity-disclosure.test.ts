import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completedProcessDurationLabel,
  formatProcessDuration,
  processLanguageFromText,
  processActivityLabel,
  shouldAutoExpandActivityGroup,
} from '../../../src/renderer/components/thread/activity-disclosure.ts';

const uuidV7At = (timestampMs: number): string => {
  const timestamp = timestampMs.toString(16).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000001`;
};

test('activity groups label every terminal Turn state', () => {
  assert.equal(processActivityLabel('completed', false), 'Processed');
  assert.equal(processActivityLabel('interrupted', false), 'Process stopped');
  assert.equal(processActivityLabel('failed', false), 'Process failed');
});

test('process copy follows the language of the original user message', () => {
  assert.equal(processLanguageFromText('review一下当前项目'), 'zh');
  assert.equal(processLanguageFromText('Review the current project'), 'en');
  assert.equal(processActivityLabel('inProgress', false, 'zh'), '正在处理');
  assert.equal(processActivityLabel('completed', false, 'zh'), '已处理');
  assert.equal(processActivityLabel('failed', false, 'zh'), '处理失败');
  assert.equal(processActivityLabel('inProgress', true, 'zh'), '需要操作');
});

test('active and attention-required activity groups start expanded', () => {
  assert.equal(shouldAutoExpandActivityGroup('inProgress', false), true);
  assert.equal(shouldAutoExpandActivityGroup('completed', true), true);
  assert.equal(shouldAutoExpandActivityGroup('completed', false), false);
});

test('attention label takes precedence over the Turn state', () => {
  assert.equal(processActivityLabel('inProgress', true), 'Action required');
  assert.equal(processActivityLabel('failed', true), 'Action required');
});

test('formats completed process duration like the Codex disclosure', () => {
  assert.equal(formatProcessDuration(5_000), '5s');
  assert.equal(formatProcessDuration(359_999), '5m 59s');
  assert.equal(formatProcessDuration(3_723_000), '1h 2m 3s');
  assert.equal(formatProcessDuration(3_723_000, 'zh'), '1小时2分3秒');
});

test('derives completed duration from canonical UUIDv7 lifecycle IDs', () => {
  assert.equal(
    completedProcessDurationLabel(uuidV7At(1_000), uuidV7At(360_999)),
    '5m 59s',
  );
  assert.equal(completedProcessDurationLabel('invalid', uuidV7At(2_000)), undefined);
  assert.equal(completedProcessDurationLabel(uuidV7At(2_000), undefined), undefined);
});
