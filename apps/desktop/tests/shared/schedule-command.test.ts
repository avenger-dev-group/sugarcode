import assert from 'node:assert/strict';
import test from 'node:test';

import { parseScheduleCommand } from '../../src/shared/schedule-command.ts';

const now = new Date(2026, 8, 4, 10, 0).getTime();

test('schedule commands extract recurring and one-off timing', () => {
  const daily = parseScheduleCommand('帮我创建一个定时任务，每天早上9点分析昨天的销售数据并生成 Excel', now);
  assert.equal(daily?.input.timing.frequency, 'daily');
  assert.equal(daily?.input.timing.time, '09:00');
  assert.equal(daily?.input.prompt, '分析昨天的销售数据并生成 Excel');
  assert.deepEqual(daily?.missing, []);

  const natural = parseScheduleCommand('请每天晚上八点帮我汇总当天的订单', now);
  assert.equal(natural?.input.timing.time, '20:00');
  assert.equal(natural?.input.prompt, '帮我汇总当天的订单');

  const later = parseScheduleCommand('创建一个定时任务，5分钟后提醒我检查报表', now);
  assert.equal(later?.input.timing.frequency, 'once');
  assert.equal(later?.input.timing.runAt, now + 5 * 60_000);
  assert.deepEqual(later?.missing, []);
});

test('schedule commands report missing fields and ignore ordinary questions', () => {
  const incomplete = parseScheduleCommand('帮我创建一个定时任务，统计销售数据', now);
  assert.equal(incomplete?.input.prompt, '统计销售数据');
  assert.deepEqual(incomplete?.missing, ['frequency', 'time']);
  assert.equal(parseScheduleCommand('现在定时任务是否支持对话创建？', now), null);
  assert.equal(parseScheduleCommand('请帮我分析这个定时任务的报错', now), null);
});
