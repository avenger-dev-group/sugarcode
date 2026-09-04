import { CalendarClock, Check, ChevronRight, Clock3, FileText, LoaderCircle, PanelRightClose, PanelRightOpen, Pause, Pencil, Play, Plus, Search, Square, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { MainSurfaceHeader } from '@/renderer/components/foundation/main-surface-header';
import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { acceptForegroundCommit } from '@/renderer/stores/conversation-projection-store';
import { acceptWorkspaceSnapshot } from '@/renderer/stores/workspace-projection-store';
import { isActiveScheduledRun, type ScheduleInput, type ScheduledRun, type ScheduledTask } from '@/shared/schedules';
import type { ParsedScheduleCommand, ScheduleCommandMissingField } from '@/shared/schedule-command';
import type { ThreadStore } from '@/renderer/components/thread/types';
import type { useSchedules } from './use-schedules';
import { ScheduleEditor } from './schedule-editor';
import { ScheduledRunDetail } from './scheduled-run-detail';

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dateLabel = (time?: number | null): string => time ? new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const cadence = (task: ScheduledTask): string => task.timing.frequency === 'once'
  ? `单次 · ${dateLabel(task.timing.runAt)}`
  : `${task.timing.frequency === 'daily' ? '每天' : task.timing.frequency === 'weekdays' ? '工作日' : `每${weekdays[task.timing.weekday]}`} ${task.timing.time}`;
const statuses: Record<ScheduledRun['status'], string> = { queued: '准备中', running: '执行中', waiting: '等待处理', completed: '已完成', failed: '失败', interrupted: '已停止', skipped: '已跳过' };
const freshInput = (): ScheduleInput => ({
  name: '', prompt: '', workspacePath: '', modelProfileId: '', enabled: true, autoApprove: false, timeoutMinutes: 120,
  timing: { frequency: 'daily', time: '02:00', weekday: 1, runAt: Date.now() + 3_600_000 },
});

type Store = ReturnType<typeof useSchedules>;
export const SchedulesPanel = ({ store, threadStore, modelOptions, onOpenRun, navigatorOpen, contextRailOpen, onToggleContextRail, approvalSurface, initialDraft, onInitialDraftHandled, onDetailRunChange }: {
  store: Store;
  threadStore: ThreadStore;
  modelOptions: ThreadStore['modelOptions'];
  onOpenRun: (run: ScheduledRun, artifact?: string) => void;
  navigatorOpen: boolean;
  contextRailOpen: boolean;
  onToggleContextRail: () => void;
  approvalSurface?: ReactNode;
  initialDraft?: ParsedScheduleCommand;
  onInitialDraftHandled: () => void;
  onDetailRunChange: (runId?: string) => void;
}) => {
  const [tab, setTab] = useState<'tasks' | 'history'>('tasks');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ id?: string; input: ScheduleInput; missing?: readonly ScheduleCommandMissingField[] }>();
  const [busy, setBusy] = useState<string>();
  const [selectedTask, setSelectedTask] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [detailRunId, setDetailRunId] = useState<string>();
  const [openedRunId, setOpenedRunId] = useState<string>();
  const [deleteRun, setDeleteRun] = useState<ScheduledRun>();
  const [deleteError, setDeleteError] = useState<string>();
  const { snapshot, request } = store;
  useEffect(() => {
    if (!initialDraft) return;
    setEditor({ input: initialDraft.input, missing: initialDraft.missing });
    onInitialDraftHandled();
  }, [initialDraft, onInitialDraftHandled]);
  const pending = snapshot.runs.filter((r) => !isActiveScheduledRun(r) && !r.reviewedAt);
  const action = async (key: string, operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(key);
    try { await operation(); } finally { setBusy(undefined); }
  };
  const openRun = (run: ScheduledRun, artifact?: string, showDetail = false): void => {
    if (openedRunId === run.id && threadStore.thread.threadIdentity === run.threadId) {
      onDetailRunChange(run.id);
      if (showDetail) setDetailRunId(run.id);
      onOpenRun(run, artifact);
      return;
    }
    void action(run.id, async () => {
      const result = await request({ action: 'open', id: run.id });
      if (!result.accepted || !result.navigation?.commit) return;
      acceptWorkspaceSnapshot(result.navigation.commit.workspace);
      acceptForegroundCommit(result.navigation.commit);
      setOpenedRunId(run.id);
      onDetailRunChange(run.id);
      if (showDetail) setDetailRunId(run.id);
      onOpenRun(run, artifact);
    });
  };
  const tasks = snapshot.tasks.filter((t) => `${t.name} ${t.prompt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const runs = (reviewOnly ? pending : snapshot.runs).filter((r) =>
    (!selectedTask || r.scheduleId === selectedTask) && `${r.name} ${r.summary}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  const openSummaryFile = (run: ScheduledRun, reference: string): void => {
    const normalized = reference.replaceAll('\\', '/');
    const artifact = run.artifacts.find((candidate) => {
      const value = candidate.replaceAll('\\', '/');
      return value === normalized || value.endsWith(`/${normalized}`) || normalized.endsWith(`/${value}`);
    }) ?? reference;
    openRun(run, artifact);
  };

  const openDetailArtifact = (run: ScheduledRun, reference: string): void => {
    const normalized = reference.replaceAll('\\', '/');
    const artifact = run.artifacts.find((candidate) => {
      const value = candidate.replaceAll('\\', '/');
      return value === normalized || value.endsWith(`/${normalized}`) || normalized.endsWith(`/${value}`);
    }) ?? reference;
    onOpenRun(run, artifact);
  };

  const confirmRunDeletion = async (): Promise<void> => {
    if (!deleteRun || busy) return;
    const deleting = deleteRun;
    setBusy(deleting.id);
    setDeleteError(undefined);
    try {
      const result = await request({ action: 'removeRun', id: deleting.id });
      if (!result.accepted) {
        setDeleteError(result.error ?? '无法删除这条执行记录。');
        return;
      }
      if (detailRunId === deleting.id) setDetailRunId(undefined);
      if (openedRunId === deleting.id) setOpenedRunId(undefined);
      if (expanded === deleting.id) setExpanded(undefined);
      onDetailRunChange(undefined);
      setDeleteRun(undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const deletionDialog = <AlertDialog open={Boolean(deleteRun)} onOpenChange={(open) => { if (!open && !busy) { setDeleteRun(undefined); setDeleteError(undefined); } }}>
    <AlertDialogContent className="max-w-md p-5">
      <AlertDialogHeader>
        <AlertDialogTitle>删除这条执行记录？</AlertDialogTitle>
        <AlertDialogDescription>
          “{deleteRun?.name}”的执行记录、内部对话，以及本次产物目录中的全部文件都会被永久删除，无法恢复。
        </AlertDialogDescription>
      </AlertDialogHeader>
      {deleteError ? <p className="mt-3 text-sm text-destructive" role="alert">{deleteError}</p> : null}
      <AlertDialogFooter className="mt-5">
        <AlertDialogCancel asChild><Button type="button" variant="outline" disabled={!!busy}>取消</Button></AlertDialogCancel>
        <Button type="button" variant="destructive" disabled={!!busy} onClick={() => void confirmRunDeletion()}>
          {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
          {busy ? '正在删除…' : '删除记录和文件'}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;

  const detailRun = snapshot.runs.find((run) => run.id === detailRunId);
  if (detailRun) return <>
    <ScheduledRunDetail run={detailRun} threadStore={threadStore} busy={!!busy}
      contextRailOpen={contextRailOpen} onToggleContextRail={onToggleContextRail}
      approvalSurface={approvalSurface}
      onBack={() => setDetailRunId(undefined)} onOpenArtifact={(file) => openDetailArtifact(detailRun, file)}
      onReview={() => void action(detailRun.id, () => request({ action: 'review', id: detailRun.id }))}
      onStop={() => void action(detailRun.id, () => request({ action: 'stop', id: detailRun.id }))}
      onDelete={() => { setDeleteError(undefined); setDeleteRun(detailRun); }} />
    {deletionDialog}
  </>;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="定时任务面板">
      <MainSurfaceHeader icon={<CalendarClock className="size-5" />} title="定时任务" description="安排重复工作，回来时查看结果。" leadingInset={!navigatorOpen}
        actions={<>
          <Button onClick={() => setEditor({ input: freshInput() })}><Plus className="size-4" />新建定时任务</Button>
          <Button type="button" size="icon-sm" variant="ghost" className="text-tertiary" onClick={onToggleContextRail}
            aria-controls="workspace-tools" aria-expanded={contextRailOpen}
            aria-label={contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'}
            title={contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'}>
            {contextRailOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
          </Button>
        </>} />
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3 sm:px-8">
        <div className="mr-auto flex items-center gap-1 rounded-lg bg-surface p-1" role="tablist" aria-label="定时任务视图">
          {([['tasks', '任务计划', snapshot.tasks.length], ['history', '执行记录', snapshot.runs.length]] as const).map(([key, label, count]) => (
            <button type="button" key={key} role="tab" aria-selected={tab === key}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${tab === key ? 'bg-background text-foreground shadow-sm' : 'text-secondary hover:text-foreground'}`}
              onClick={() => { setTab(key); setSelectedTask(undefined); setReviewOnly(false); }}>
              {label}<span className="ml-2 font-mono text-[10px] text-tertiary">{count}</span>
            </button>
          ))}
        </div>
        {tab === 'history' ? <button type="button" aria-pressed={reviewOnly}
          className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${reviewOnly ? 'border-amber-500/30 bg-amber-500/10 text-amber-700' : 'text-secondary hover:bg-surface hover:text-foreground'}`}
          onClick={() => setReviewOnly((value) => !value)}>
          待审阅<span className="ml-1.5 font-mono text-[10px]">{pending.length}</span>
        </button> : null}
        <div className="relative w-48"><Search className="absolute left-2.5 top-2.5 size-3.5 text-tertiary" /><Input className="h-8 pl-8 text-xs" aria-label="搜索定时任务" placeholder="搜索任务或结果" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      </div>
      <div className="flex-1 overflow-auto px-6 py-5 sm:px-8">
        {store.error ? <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{store.error}</p> : null}
        {store.loading ? <div className="flex items-center gap-2 py-12 text-sm text-secondary"><LoaderCircle className="size-4 animate-spin" />正在加载…</div> : tab === 'tasks' ? (
          tasks.length ? <div className="space-y-3">{tasks.map((task) => {
            const last = snapshot.runs.find((r) => r.scheduleId === task.id);
            const active = snapshot.runs.some((r) => r.scheduleId === task.id && isActiveScheduledRun(r));
            return <article key={task.id} className="rounded-xl border bg-background p-4 transition-colors hover:border-border-strong">
              <div className="flex items-start gap-3">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${task.enabled ? 'bg-emerald-500' : 'bg-tertiary/40'}`} aria-label={task.enabled ? '已启用' : '已暂停'} />
                <button className="min-w-0 flex-1 text-left" type="button" onClick={() => { setSelectedTask(task.id); setReviewOnly(false); setTab('history'); }}>
                  <h2 className="truncate text-sm font-semibold">{task.name}</h2>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-secondary">{task.prompt}</p>
                </button>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`编辑 ${task.name}`} onClick={() => setEditor({ id: task.id, input: task })}><Pencil /></Button>
                  <Button variant="ghost" size="icon-sm" disabled={!!busy} aria-label={`${task.enabled ? '暂停' : '启用'} ${task.name}`} onClick={() => void action(task.id, () => request({ action: 'toggle', id: task.id, enabled: !task.enabled }))}>{task.enabled ? <Pause /> : <Play />}</Button>
                  <Button variant="ghost" size="icon-sm" disabled={!!busy || active} aria-label={`删除计划 ${task.name}`} onClick={() => void action(task.id, () => request({ action: 'remove', id: task.id }))}><Trash2 /></Button>
                </div>
              </div>
              <div className="ml-5 mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border-subtle pt-3 text-[11px] text-secondary">
                <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3" />{cadence(task)}</span>
                <span>下次：{task.enabled ? dateLabel(task.nextRunAt) : '已暂停'}</span>
                <span>最近：{last ? statuses[last.status] : '尚未运行'}</span>
                <Button className="ml-auto" variant="outline" disabled={!!busy || active} onClick={() => void action(task.id, () => request({ action: 'run', id: task.id }))}>
                  {active ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" />}{active ? '执行中' : '立即运行'}
                </Button>
              </div>
            </article>;
          })}</div> : <EmptyState title="让重复工作按时完成" description="描述要做的事、安排时间，Agent 会调用所需能力，并保存结果供你审阅。" onCreate={() => setEditor({ input: freshInput() })} />
        ) : (
          <>
            {selectedTask ? <button type="button" className="mb-4 text-xs text-link" onClick={() => setSelectedTask(undefined)}>显示全部执行记录</button> : null}
            {runs.length ? <div className="space-y-3">{runs.map((run) => <article key={run.id} className="overflow-hidden rounded-xl border bg-background">
              <div className="flex items-center gap-3 px-4 py-3">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={expanded === run.id} onClick={() => setExpanded(expanded === run.id ? undefined : run.id)}>
                  <ChevronRight className={`size-3.5 shrink-0 text-tertiary ${expanded === run.id ? 'rotate-90' : ''}`} />
                  <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{run.name}</h2><p className="mt-1 text-[11px] text-tertiary">{dateLabel(run.scheduledAt)} · {run.artifacts.length} 个产物</p></div>
                  <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${run.status === 'failed' ? 'bg-destructive/10 text-destructive' : run.status === 'waiting' || (!isActiveScheduledRun(run) && !run.reviewedAt) ? 'bg-amber-500/10 text-amber-700' : 'bg-surface text-secondary'}`}>{statuses[run.status]}{!isActiveScheduledRun(run) ? run.reviewedAt ? ' · 已审阅' : ' · 待审阅' : ''}</span>
                </button>
                {isActiveScheduledRun(run) ? <Button variant="ghost" size="icon-sm" aria-label="停止本次执行" disabled={!!busy} onClick={() => void action(run.id, () => request({ action: 'stop', id: run.id }))}><Square /></Button> : !run.reviewedAt ? <Button variant="ghost" size="icon-sm" aria-label="标记为已审阅" disabled={!!busy} onClick={() => void action(run.id, () => request({ action: 'review', id: run.id }))}><Check /></Button> : null}
                {!isActiveScheduledRun(run) ? <Button variant="ghost" size="icon-sm" className="text-tertiary hover:text-destructive" aria-label={`删除执行记录 ${run.name}`} title="删除执行记录" disabled={!!busy} onClick={() => { setDeleteError(undefined); setDeleteRun(run); }}><Trash2 /></Button> : null}
                <Button variant="outline" disabled={!!busy || !run.threadId} onClick={() => openRun(run, undefined, true)}>打开结果</Button>
              </div>
              {expanded === run.id ? <div className="space-y-3 border-t bg-surface/25 px-5 py-4">
                {run.error ? <p className="text-xs text-destructive">{run.error}</p> : null}
                {run.summary ? (
                  <div className="text-sm leading-6 text-secondary">
                    <AgentMarkdown source={run.summary} isStreaming={false} verifiedFilePaths={run.artifacts} onOpenFile={(file) => openSummaryFile(run, file)} />
                  </div>
                ) : <p className="text-sm leading-6 text-secondary">{isActiveScheduledRun(run) ? '任务正在处理，打开对话可查看详细过程。' : '本次没有文字摘要。'}</p>}
                {run.artifacts.length ? <div className="flex flex-wrap gap-2">{run.artifacts.map((file) => <button key={file} type="button" disabled={!!busy} className="flex max-w-full items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs hover:bg-surface" title={file} onClick={() => openRun(run, file)}><FileText className="size-3.5 shrink-0 text-secondary" /><span className="truncate">{file.split('/').at(-1)}</span></button>)}</div> : null}
                <p className="truncate font-mono text-[10px] text-tertiary" title={run.workspacePath}>{run.workspacePath}</p>
              </div> : null}
            </article>)}</div> : <EmptyState title={reviewOnly ? '当前没有待审阅结果' : '还没有执行记录'} description={reviewOnly ? '未审阅的结果会集中显示在这里。' : '任务按时运行或手动执行后，可以在这里查看完整记录。'} />}
          </>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t px-6 py-3 text-[11px] text-tertiary sm:px-8"><span className="size-1.5 rounded-full bg-emerald-500" />本机执行 · 请保持电脑开机、不休眠，应用持续运行 · 时间以电脑本地时区为准</footer>
      {editor ? <ScheduleEditor key={editor.id ?? `new-${editor.input.name}`} value={editor} modelOptions={modelOptions} request={request} onClose={() => setEditor(undefined)} /> : null}
      {deletionDialog}
    </section>
  );
};

const EmptyState = ({ title, description, onCreate }: { title: string; description: string; onCreate?: () => void }) => (
  <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center">
    <span className="mb-5 grid size-14 place-items-center rounded-2xl border bg-surface shadow-sm"><CalendarClock className="size-6 text-secondary" /></span>
    <h2 className="text-base font-semibold tracking-tight">{title}</h2>
    <p className="mt-2 text-sm leading-6 text-secondary">{description}</p>
    {onCreate ? <Button className="mt-6" variant="outline" onClick={onCreate}><Plus className="size-4" />创建第一个定时任务</Button> : null}
  </div>
);
