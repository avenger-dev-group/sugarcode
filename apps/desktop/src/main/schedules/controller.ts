import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isActiveScheduledRun, isScheduleInput, isSchedulesSnapshot, nextScheduledTime,
  type ScheduleInput, type ScheduledRun, type ScheduledTask, type SchedulesSnapshot,
} from '../../shared/schedules.ts';
import type { RuntimeEvent, RuntimeThreadSnapshot } from '../../runtime/contracts/protocol.ts';
import type { RuntimeSupervisor } from '../runtime/connection/supervisor.ts';
import { createUuidV7 } from '../runtime/conversation/id.ts';

type Options = Readonly<{
  storagePath: string;
  defaultWorkspace: string;
  runtime: Pick<RuntimeSupervisor, 'request' | 'subscribe'>;
  startTurn: (snapshot: RuntimeThreadSnapshot, turnId: string, prompt: string, modelProfileId?: string) => void;
  stopTurn: (threadId: string) => Promise<unknown>;
  deleteThread: (workspaceId: string, threadId: string) => Promise<unknown>;
  preparePermissions: (workspaceId: string, root: string, threadId: string, autoApprove: boolean) => void;
  releasePermissions: (threadId: string) => void;
  activeWorkspaceId: () => string | null;
  now?: () => number;
}>;

export class SchedulesController {
  private readonly options: Options;
  private tasks: ScheduledTask[] = [];
  private runs: ScheduledRun[] = [];
  private revision = 0;
  private error: string | undefined;
  private readonly listeners = new Set<(state: SchedulesSnapshot) => void>();
  private readonly pendingInputs = new Map<string, Set<string>>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(options: Options) { this.options = options; }
  private now = (): number => this.options.now?.() ?? Date.now();
  getSnapshot = (): SchedulesSnapshot => ({ revision: this.revision, tasks: this.tasks, runs: this.runs, ...(this.error ? { error: this.error } : {}) });
  getRun = (id: string): ScheduledRun | undefined => this.runs.find((r) => r.id === id);
  subscribe = (listener: (state: SchedulesSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize = async (): Promise<void> => {
    try {
      const source = await readFile(this.options.storagePath, 'utf8');
      if (source.length > 32_000_000) throw new Error('定时任务记录过大，未自动加载。');
      const stored: unknown = JSON.parse(source);
      if (!isSchedulesSnapshot(stored)) throw new Error('定时任务存储格式无效，原文件已保留。');
      this.tasks = [...stored.tasks];
      this.runs = stored.runs.map((run) => isActiveScheduledRun(run)
        ? { ...run, status: 'interrupted', finishedAt: this.now(), error: '应用上次退出时执行尚未结束，请查看已有结果后重新运行。' }
        : run);
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.error = error instanceof Error ? error.message : '无法读取定时任务记录。';
        this.publish();
        return;
      }
    }
    this.unsubscribe = this.options.runtime.subscribe(this.handleEvent);
    this.timer = setInterval(() => void this.tick().catch(this.reportError), 15_000);
    this.timer.unref();
    await this.tick();
  };

  save = (input: ScheduleInput, id?: string): Promise<void> => this.lock(async () => {
    if (!isScheduleInput(input)) throw new Error('请检查任务名称、指令和执行时间。');
    const existing = id ? this.tasks.find((task) => task.id === id) : undefined;
    if (id && !existing) throw new Error('定时任务不存在。');
    if (!existing && this.tasks.length >= 100) throw new Error('最多保留 100 个定时任务。');
    if (input.timing.frequency === 'once' && input.enabled && input.timing.runAt <= this.now()) throw new Error('单次任务的执行时间必须晚于当前时间。');
    const taskId = existing?.id ?? randomUUID();
    let root = input.workspacePath.trim();
    if (!root) {
      root = path.join(this.options.defaultWorkspace, taskId);
      await mkdir(root, { recursive: true, mode: 0o700 });
    }
    root = await realpath(root);
    if (!(await lstat(root)).isDirectory()) throw new Error('请选择有效的工作目录。');
    const task: ScheduledTask = {
      ...input, id: taskId, workspacePath: root, name: input.name.trim(), prompt: input.prompt.trim(),
      createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now(),
      nextRunAt: input.enabled ? nextScheduledTime(input.timing, this.now()) : null,
    };
    this.tasks = [task, ...this.tasks.filter((item) => item.id !== taskId)];
    await this.persist();
  });

  toggle = (id: string, enabled: boolean): Promise<void> => this.lock(async () => {
    const task = this.requireTask(id);
    const nextRunAt = enabled ? nextScheduledTime(task.timing, this.now()) : null;
    if (enabled && nextRunAt === null) throw new Error('请先将单次执行时间修改为未来时间。');
    this.tasks = this.tasks.map((t) => t.id === id ? { ...t, enabled, nextRunAt, updatedAt: this.now() } : t);
    await this.persist();
  });

  remove = (id: string): Promise<void> => this.lock(async () => {
    this.requireTask(id);
    if (this.runs.some((run) => run.scheduleId === id && isActiveScheduledRun(run))) throw new Error('请先停止正在执行的任务。');
    this.tasks = this.tasks.filter((task) => task.id !== id);
    // Run history and generated files remain independently reviewable.
    await this.persist();
  });

  removeRun = (id: string): Promise<void> => this.lock(async () => {
    const run = this.getRun(id);
    if (!run) throw new Error('执行记录不存在。');
    if (isActiveScheduledRun(run)) throw new Error('请先停止正在执行的任务。');
    const outputDirectory = await this.resolveOutputDirectory(run);
    if (run.threadId) {
      const workspaceId = createHash('sha256').update(run.workspacePath).digest('hex');
      await this.options.deleteThread(workspaceId, run.threadId);
    }
    if (outputDirectory) await this.removeOutputDirectory(outputDirectory);
    this.runs = this.runs.filter((candidate) => candidate.id !== id);
    await this.persist();
  });

  review = (id: string): Promise<void> => this.lock(async () => {
    const run = this.getRun(id);
    if (!run || isActiveScheduledRun(run)) throw new Error('任务结束后才能标记为已审阅。');
    this.updateRun(id, { reviewedAt: this.now() });
    await this.persist();
  });

  runNow = async (id: string): Promise<void> => {
    const reserved = await this.lock(async () => {
      const task = this.requireTask(id);
      if (this.runs.some((run) => run.scheduleId === id && isActiveScheduledRun(run))) throw new Error('该定时任务已经在执行，请等待完成。');
      if (this.runs.filter(isActiveScheduledRun).length >= 3) throw new Error('已有 3 个定时任务在执行，请稍后重试。');
      const run = this.reserve(task, this.now());
      await this.persist();
      return { task, run };
    });
    void this.execute(reserved.task, reserved.run);
  };

  tick = (): Promise<void> => this.lock(async () => {
    if (this.stopped || this.error) return;
    const now = this.now();
    const due = this.tasks.filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now);
    if (!due.length) return;
    const dispatch: { task: ScheduledTask; run: ScheduledRun }[] = [];
    for (const task of due) {
      const at = task.nextRunAt as number;
      const nextRunAt = nextScheduledTime(task.timing, now);
      this.tasks = this.tasks.map((t) => t.id === task.id ? { ...t, nextRunAt, enabled: nextRunAt !== null } : t);
      const occupied = this.runs.some((r) => r.scheduleId === task.id && isActiveScheduledRun(r));
      const crowded = this.runs.filter(isActiveScheduledRun).length >= 3;
      const missed = now - at > 90_000;
      const run = this.reserve(task, at);
      if (occupied || crowded || missed) {
        this.updateRun(run.id, {
          status: 'skipped', finishedAt: now,
          error: occupied ? '上一次执行尚未结束，本次已跳过。' : crowded ? '定时任务并发已满，本次已跳过。' : '执行时间已错过（应用未运行或电脑休眠），可手动立即运行。',
        });
      } else dispatch.push({ task, run });
    }
    // Persist the next occurrence and run identity before any Agent side effects.
    await this.persist();
    for (const { task, run } of dispatch) void this.execute(task, run);
  });

  stop = async (id: string): Promise<void> => {
    const run = this.getRun(id);
    if (!run || !isActiveScheduledRun(run)) return;
    await this.finish(id, 'interrupted', '用户停止了本次执行。');
    if (run.threadId) await this.options.stopTurn(run.threadId);
  };

  dispose = (): void => {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    this.timeouts.clear();
  };

  private execute = async (task: ScheduledTask, reserved: ScheduledRun): Promise<void> => {
    try {
      if (!this.canExecute(reserved.id)) return;
      const root = await realpath(task.workspacePath);
      if (root !== task.workspacePath) throw new Error('工作目录的实际位置已变化，请重新选择目录。');
      await this.createOutputDirectory(root, reserved.outputPath);
      const workspaceId = createHash('sha256').update(root).digest('hex');
      if (this.options.activeWorkspaceId() !== workspaceId) {
        await this.options.runtime.request({ type: 'workspace.open', requestId: randomUUID(), workspaceId, canonicalRoot: root, kind: 'project' }, 'workspace.opened');
      }
      const created = await this.options.runtime.request({ type: 'thread.create', requestId: randomUUID(), workspaceId, title: `${task.name} · ${new Date(reserved.scheduledAt).toLocaleDateString('zh-CN')}` }, 'thread.mutated');
      if (!created.snapshot || created.workspaceId !== workspaceId || created.snapshot.thread.workspaceId !== workspaceId) throw new Error('无法创建本次任务的对话。');
      if (!this.canExecute(reserved.id)) return;
      const turnId = createUuidV7();
      await this.lock(async () => {
        if (!this.canExecute(reserved.id)) return;
        this.updateRun(reserved.id, { threadId: created.threadId, turnId, startedAt: this.now(), status: 'running' });
        await this.persist();
      });
      if (!this.canExecute(reserved.id)) return;
      this.options.preparePermissions(workspaceId, root, created.threadId, task.autoApprove);
      const prompt = `${task.prompt}\n\n本次为定时任务执行。计划时间：${new Date(reserved.scheduledAt).toLocaleString('zh-CN')}。\n将本次新生成的交付文件保存到工作目录下的 ${reserved.outputPath}/，不要覆盖其他执行的产物。根据任务需要生成文本、文档、表格、PDF、图片等；无需文件时直接给出结论。最终回复简述结果、数据范围及异常，并用 Markdown 文件链接列出产物，便于用户打开审阅。`;
      this.options.startTurn(created.snapshot, turnId, prompt, task.modelProfileId || undefined);
      if (!this.canExecute(reserved.id)) return;
      const timer = setTimeout(() => {
        void this.finish(reserved.id, 'failed', `执行超过 ${task.timeoutMinutes} 分钟，已停止。`)
          .then(() => this.options.stopTurn(created.threadId)).catch(this.reportError);
      }, task.timeoutMinutes * 60_000);
      timer.unref();
      this.timeouts.set(reserved.id, timer);
    } catch (error) {
      await this.finish(reserved.id, 'failed', error instanceof Error ? error.message : '无法执行定时任务。').catch(this.reportError);
    }
  };

  private handleEvent = (event: RuntimeEvent): void => {
    if (!('turnId' in event)) return;
    const run = this.runs.find((r) => r.turnId === event.turnId && isActiveScheduledRun(r));
    if (!run) return;
    if (event.type === 'turn.completed') {
      void this.finish(run.id, event.status, event.error?.message).catch(this.reportError);
    } else if (event.type === 'turn.textCompleted' && event.phase === 'final') {
      void this.lock(async () => { this.updateRun(run.id, { summary: event.text.slice(0, 64_000) }); await this.persist(); }).catch(this.reportError);
    } else if (['approval.requested', 'mcp.approvalRequested', 'turn.userInputRequested', 'approval.resolved', 'mcp.approvalResolved', 'turn.userInputResolved'].includes(event.type)) {
      const id = 'approvalId' in event ? event.approvalId : 'inputRequestId' in event ? String(event.inputRequestId) : 'user-input';
      const pending = this.pendingInputs.get(run.id) ?? new Set<string>();
      if (event.type.endsWith('Requested') || event.type.endsWith('.requested')) pending.add(id);
      else pending.delete(id);
      this.pendingInputs.set(run.id, pending);
      void this.lock(async () => {
        if (isActiveScheduledRun(this.getRun(run.id) ?? run)) this.updateRun(run.id, { status: pending.size ? 'waiting' : 'running' });
        await this.persist();
      }).catch(this.reportError);
    }
  };

  private finish = (id: string, status: 'completed' | 'failed' | 'interrupted', error?: string): Promise<void> => this.lock(async () => {
    const run = this.getRun(id);
    if (!run || !isActiveScheduledRun(run)) return;
    clearTimeout(this.timeouts.get(id));
    this.timeouts.delete(id);
    this.pendingInputs.delete(id);
    if (run.threadId) this.options.releasePermissions(run.threadId);
    const artifacts = await this.collectArtifacts(run.workspacePath, run.outputPath).catch(() => [] as string[]);
    this.updateRun(id, { status, finishedAt: this.now(), artifacts, ...(error ? { error: error.slice(0, 4000) } : {}) });
    await this.persist();
  });

  private reserve = (task: ScheduledTask, scheduledAt: number): ScheduledRun => {
    const id = randomUUID();
    const run: ScheduledRun = {
      id, scheduleId: task.id, name: task.name, prompt: task.prompt, workspacePath: task.workspacePath,
      outputPath: `.sugarcode/automations/${task.id}/${id}`, scheduledAt,
      status: 'queued', summary: '', artifacts: [],
    };
    this.runs = [run, ...this.runs];
    return run;
  };
  private canExecute = (id: string): boolean => !this.stopped && !this.error && !!this.getRun(id) && isActiveScheduledRun(this.getRun(id) as ScheduledRun);
  private requireTask = (id: string): ScheduledTask => {
    const task = this.tasks.find((task) => task.id === id);
    if (!task) throw new Error('定时任务不存在。');
    return task;
  };
  private updateRun = (id: string, patch: Partial<ScheduledRun>): void => { this.runs = this.runs.map((run) => run.id === id ? { ...run, ...patch } : run); };
  private lock = <T>(action: () => Promise<T>): Promise<T> => {
    const result = this.serial.then(() => {
      if (this.error) throw new Error(this.error);
      return action();
    });
    this.serial = result.catch((): undefined => undefined);
    return result;
  };
  private persist = async (): Promise<void> => {
    try {
      await mkdir(path.dirname(this.options.storagePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.storagePath}.tmp`;
      await writeFile(temporary, JSON.stringify({ revision: this.revision + 1, tasks: this.tasks, runs: this.runs }), { mode: 0o600 });
      await rename(temporary, this.options.storagePath);
      this.publish();
    } catch (error) {
      this.reportError(new Error('定时任务记录无法保存，调度已暂停。请检查磁盘空间后重启应用。'));
      throw error;
    }
  };
  private reportError = (error: unknown): void => {
    this.error = error instanceof Error ? error.message : '定时任务发生错误。';
    this.publish();
  };
  private publish = (): void => {
    this.revision += 1;
    for (const listener of this.listeners) listener(this.getSnapshot());
  };
  private createOutputDirectory = async (root: string, relative: string): Promise<void> => {
    let current = root;
    for (const segment of relative.split('/')) {
      if (!segment || segment === '.' || segment === '..') throw new Error('输出目录无效。');
      current = path.join(current, segment);
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('输出目录不能经过符号链接。');
    }
  };
  private collectArtifacts = async (root: string, relative: string): Promise<string[]> => {
    const result: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || result.length >= 500) return;
      const absolute = path.join(root, directory);
      const canonical = await realpath(absolute);
      if (canonical !== absolute || !(await lstat(absolute)).isDirectory()) return;
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (result.length >= 500) break;
        const child = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(child, depth + 1);
        else if (entry.isFile()) result.push(child);
      }
    };
    await walk(relative, 0);
    return result.sort();
  };
  private resolveOutputDirectory = async (run: ScheduledRun): Promise<string | null> => {
    const segments = run.outputPath.replaceAll('\\', '/').split('/');
    const expected = ['.sugarcode', 'automations', run.scheduleId, run.id];
    if (segments.length !== expected.length || segments.some((segment, index) => segment !== expected[index])) {
      throw new Error('执行记录的产物目录无效，未执行删除。');
    }
    let root: string;
    try {
      root = await realpath(run.workspacePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (root !== run.workspacePath) throw new Error('工作目录的实际位置已变化，未执行删除。');
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('产物目录不能经过符号链接，未执行删除。');
      }
    }
    if (await realpath(current) !== current) throw new Error('产物目录的实际位置已变化，未执行删除。');
    return current;
  };
  private removeOutputDirectory = async (directory: string): Promise<void> => {
    await rm(directory, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    await rmdir(path.dirname(directory)).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error;
    });
  };
}
