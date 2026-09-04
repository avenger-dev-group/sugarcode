import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SchedulesController } from '../../../src/main/schedules/controller.ts';
import { createUuidV7 } from '../../../src/main/runtime/conversation/id.ts';
import type { RuntimeSupervisor } from '../../../src/main/runtime/connection/supervisor.ts';
import type { RuntimeCommand, RuntimeEvent, RuntimeThreadSnapshot } from '../../../src/runtime/contracts/protocol.ts';
import { nextScheduledTime, type ScheduleInput } from '../../../src/shared/schedules.ts';

const eventually = async (condition: () => boolean): Promise<void> => {
  const end = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > end) assert.fail('Scheduled operation did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sugarcode-schedules-')));
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const commands: RuntimeCommand[] = [];
  const starts: { snapshot: RuntimeThreadSnapshot; turnId: string; prompt: string }[] = [];
  const grants: boolean[] = [];
  const releases: string[] = [];
  const stops: string[] = [];
  const deletions: { workspaceId: string; threadId: string }[] = [];
  let now = new Date(2026, 8, 4, 1, 0).getTime();
  const runtime = {
    subscribe: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (command: RuntimeCommand) => {
      commands.push(command);
      if (command.type === 'workspace.open') return { type: 'workspace.opened', workspaceId: command.workspaceId };
      if (command.type !== 'thread.create') throw new Error('Unexpected request');
      const id = createUuidV7();
      const snapshot: RuntimeThreadSnapshot = { thread: { id, workspaceId: command.workspaceId, title: command.title ?? null, createdAt: now, updatedAt: now, archivedAt: null, parentThreadId: null }, turns: [], items: [], agentTasks: [], queue: { paused: false, messages: [] } };
      return { type: 'thread.mutated', workspaceId: command.workspaceId, threadId: id, snapshot };
    },
  } as unknown as RuntimeSupervisor;
  const options = {
    runtime, storagePath: path.join(root, 'state.json'), defaultWorkspace: path.join(root, 'defaults'), now: () => now,
    activeWorkspaceId: () => createHash('sha256').update(root).digest('hex'),
    preparePermissions: (_id: string, _root: string, _thread: string, auto: boolean) => { grants.push(auto); },
    releasePermissions: (thread: string) => { releases.push(thread); },
    stopTurn: async (thread: string) => { stops.push(thread); },
    deleteThread: async (workspaceId: string, threadId: string) => { deletions.push({ workspaceId, threadId }); },
    startTurn: (snapshot: RuntimeThreadSnapshot, turnId: string, prompt: string) => { starts.push({ snapshot, turnId, prompt }); },
  };
  const controller = new SchedulesController(options);
  await controller.initialize();
  const input: ScheduleInput = { name: '夜间分析', prompt: '分析资料并输出报告', workspacePath: root, modelProfileId: '', enabled: true, autoApprove: false, timeoutMinutes: 1, timing: { frequency: 'once', time: '02:00', weekday: 1, runAt: now + 60_000 } };
  return { root, controller, options, starts, commands, grants, releases, stops, deletions, input,
    advance: (ms: number) => { now += ms; },
    emit: (event: RuntimeEvent) => { for (const listener of listeners) listener(event); },
    cleanup: async () => { controller.dispose(); await rm(root, { recursive: true, force: true }); },
  };
};

test('scheduled execution collects files; deleting its record removes files and the hidden thread', async () => {
  const f = await fixture();
  try {
    await f.controller.save(f.input);
    f.advance(60_000);
    await Promise.all([f.controller.tick(), f.controller.tick()]);
    await eventually(() => f.starts.length === 1);
    assert.equal(f.commands.some((c) => c.type === 'workspace.open'), false, 'foreground workspace must not reopen');
    const run = f.controller.getSnapshot().runs[0];
    assert.equal(f.controller.getSnapshot().tasks[0].enabled, false);
    assert.equal(JSON.parse(await readFile(f.options.storagePath, 'utf8')).runs[0].status, 'running');
    assert.match(f.starts[0].prompt, /\.sugarcode\/automations/);
    assert.deepEqual(f.grants, [false]);
    await writeFile(path.join(f.root, run.outputPath, 'report.md'), '# Result');
    await symlink(path.join(f.root, 'state.json'), path.join(f.root, run.outputPath, 'outside.json'));
    const eventBase = { sequence: 1, workspaceId: f.starts[0].snapshot.thread.workspaceId, threadId: run.threadId, turnId: run.turnId };
    f.emit({ ...eventBase, type: 'turn.textCompleted', phase: 'final', text: '分析完成' } as RuntimeEvent);
    f.emit({ ...eventBase, type: 'turn.completed', status: 'completed' } as RuntimeEvent);
    await eventually(() => f.controller.getSnapshot().runs[0].status === 'completed');
    await f.controller.review(run.id);
    await f.controller.remove(run.scheduleId);
    const done = f.controller.getSnapshot().runs[0];
    assert.equal(done.summary, '分析完成');
    assert.deepEqual(done.artifacts, [`${run.outputPath}/report.md`]);
    assert.ok(done.reviewedAt);
    assert.equal(f.releases.length, 1);
    assert.equal(f.controller.getSnapshot().tasks.length, 0);
    await f.controller.removeRun(done.id);
    assert.equal(f.controller.getSnapshot().runs.length, 0);
    assert.deepEqual(f.deletions, [{
      workspaceId: createHash('sha256').update(f.root).digest('hex'),
      threadId: done.threadId,
    }]);
    await assert.rejects(readFile(path.join(f.root, run.outputPath, 'report.md')), { code: 'ENOENT' });
    await assert.rejects(realpath(path.dirname(path.join(f.root, run.outputPath))), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(f.options.storagePath, 'utf8')).runs.length, 0);
  } finally { await f.cleanup(); }
});

test('overlap and concurrency are bounded; stopping releases permissions', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++) await f.controller.save({ ...f.input, name: `task ${i}`, autoApprove: true });
    const tasks = f.controller.getSnapshot().tasks;
    for (const task of tasks.slice(0, 3)) await f.controller.runNow(task.id);
    await eventually(() => f.starts.length === 3);
    await assert.rejects(f.controller.runNow(tasks[0].id), /已经在执行/);
    await assert.rejects(f.controller.runNow(tasks[3].id), /3 个/);
    const run = f.controller.getSnapshot().runs[0];
    await assert.rejects(f.controller.removeRun(run.id), /先停止/);
    await f.controller.stop(run.id);
    assert.equal(f.controller.getRun(run.id)?.status, 'interrupted');
    assert.deepEqual(f.stops, [run.threadId]);
    assert.equal(f.releases.length, 1);
    assert.deepEqual(f.grants, [true, true, true]);
  } finally { await f.cleanup(); }
});

test('missed schedules are recorded once and restart never replays an interrupted run', async () => {
  const f = await fixture();
  let restored: SchedulesController | undefined;
  try {
    await f.controller.save(f.input);
    f.advance(600_000);
    await f.controller.tick();
    await f.controller.tick();
    assert.equal(f.controller.getSnapshot().runs.length, 1);
    assert.equal(f.controller.getSnapshot().runs[0].status, 'skipped');
    assert.equal(f.starts.length, 0);
    await f.controller.runNow(f.controller.getSnapshot().tasks[0].id);
    await eventually(() => f.starts.length === 1);
    f.controller.dispose();
    restored = new SchedulesController(f.options);
    await restored.initialize();
    assert.equal(restored.getSnapshot().runs[0].status, 'interrupted');
    assert.equal(f.starts.length, 1);
  } finally { restored?.dispose(); await f.cleanup(); }
});

test('invalid storage fails closed and is preserved', async () => {
  const f = await fixture();
  f.controller.dispose();
  const broken = new SchedulesController(f.options);
  try {
    await writeFile(f.options.storagePath, '{broken');
    await broken.initialize();
    assert.ok(broken.getSnapshot().error);
    await assert.rejects(broken.save(f.input));
    assert.equal(await readFile(f.options.storagePath, 'utf8'), '{broken');
  } finally { broken.dispose(); await f.cleanup(); }
});

test('unsafe output path fails one run without pausing other schedules', async () => {
  const f = await fixture();
  try {
    await symlink(f.root, path.join(f.root, '.sugarcode'));
    await f.controller.save(f.input);
    await f.controller.runNow(f.controller.getSnapshot().tasks[0].id);
    await eventually(() => f.controller.getSnapshot().runs[0].status === 'failed');
    assert.match(f.controller.getSnapshot().runs[0].error ?? '', /符号链接/);
    assert.equal(f.controller.getSnapshot().error, undefined);
    assert.equal(f.starts.length, 0);
  } finally { await f.cleanup(); }
});

test('run deletion rejects a stored output path outside its execution directory before side effects', async () => {
  const f = await fixture();
  let restored: SchedulesController | undefined;
  try {
    await f.controller.save(f.input);
    f.advance(600_000);
    await f.controller.tick();
    f.controller.dispose();
    const stored = JSON.parse(await readFile(f.options.storagePath, 'utf8')) as {
      runs: Array<Record<string, unknown>>;
    };
    stored.runs[0] = { ...stored.runs[0], outputPath: 'outside', threadId: createUuidV7() };
    await writeFile(f.options.storagePath, JSON.stringify(stored));
    const outside = path.join(f.root, 'outside');
    await writeFile(outside, 'keep');
    restored = new SchedulesController(f.options);
    await restored.initialize();
    const run = restored.getSnapshot().runs[0];
    await assert.rejects(restored.removeRun(run.id), /产物目录无效/);
    assert.equal(await readFile(outside, 'utf8'), 'keep');
    assert.equal(restored.getSnapshot().runs.length, 1);
    assert.deepEqual(f.deletions, []);
  } finally { restored?.dispose(); await f.cleanup(); }
});

test('weekday and weekly timing follow local dates and advance strictly', () => {
  const friday = new Date(2026, 8, 4, 9, 0).getTime();
  const timing = { frequency: 'weekdays', time: '09:00', weekday: 5, runAt: 0 } as const;
  assert.equal(nextScheduledTime(timing, friday), new Date(2026, 8, 7, 9, 0).getTime());
  assert.equal(nextScheduledTime({ ...timing, frequency: 'weekly' }, friday), new Date(2026, 8, 11, 9, 0).getTime());
  assert.equal(nextScheduledTime({ ...timing, frequency: 'once', runAt: friday }, friday), null);
});
