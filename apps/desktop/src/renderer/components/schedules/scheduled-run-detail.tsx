import { ArrowLeft, Check, FileText, LoaderCircle, PanelRightClose, PanelRightOpen, Send, Square, Trash2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { Button } from '@/renderer/components/ui/button';
import { Textarea } from '@/renderer/components/ui/textarea';
import { TranscriptTurn } from '@/renderer/components/thread/thread-workbench';
import { resolveComposerSurface } from '@/renderer/components/thread/composer-state';
import { toTranscriptTurnBoundary } from '@/renderer/components/thread/turn-boundary';
import type { ThreadStore, TurnViewModel } from '@/renderer/components/thread/types';
import { UserInputSurface } from '@/renderer/components/user-input/user-input-surface';
import { isActiveScheduledRun, type ScheduledRun } from '@/shared/schedules';

const statusLabel: Record<ScheduledRun['status'], string> = {
  queued: '准备中', running: '执行中', waiting: '等待处理', completed: '已完成',
  failed: '失败', interrupted: '已停止', skipped: '已跳过',
};

const dateLabel = (time?: number | null): string => time
  ? new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

const taskFacingTurn = (turn: TurnViewModel, prompt: string): TurnViewModel => {
  let replaced = false;
  return {
    ...turn,
    messages: turn.messages.map((entry) => {
      if (replaced || entry.role !== 'user') return entry;
      replaced = true;
      return { ...entry, message: { ...entry.message, text: prompt } };
    }),
  };
};

export const ScheduledRunDetail = ({ run, threadStore, busy, contextRailOpen, onToggleContextRail, approvalSurface, onBack, onOpenArtifact, onReview, onStop, onDelete }: {
  run: ScheduledRun;
  threadStore: ThreadStore;
  busy: boolean;
  contextRailOpen: boolean;
  onToggleContextRail: () => void;
  approvalSurface?: ReactNode;
  onBack: () => void;
  onOpenArtifact: (path: string) => void;
  onReview: () => void;
  onStop: () => void;
  onDelete: () => void;
}) => {
  const threadReady = threadStore.thread.threadIdentity === run.threadId && !threadStore.thread.isEmpty;
  const turns = useMemo(() => threadStore.thread.turns.map((turn, index) => index === 0 ? taskFacingTurn(turn, run.prompt) : turn), [run.prompt, threadStore.thread.turns]);
  const userInputTurn = threadStore.thread.turns.findLast((turn) => turn.userInputRequest !== undefined);
  const composerSurface = resolveComposerSurface(Boolean(approvalSurface), Boolean(userInputTurn?.userInputRequest));
  const showInteractionFooter = threadReady || composerSurface !== 'composer';
  const terminal = !isActiveScheduledRun(run);

  return <section className="flex h-full min-h-0 flex-col bg-background" aria-label={`定时任务执行详情：${run.name}`}>
    <header className="window-main-surface-header shrink-0 border-b bg-surface/30 px-6 py-4 sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <Button type="button" size="icon-sm" variant="ghost" aria-label="返回执行记录" onClick={onBack}><ArrowLeft aria-hidden="true" /></Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">{run.name}</h1>
            <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${run.status === 'failed' ? 'bg-destructive/10 text-destructive' : run.status === 'waiting' || (terminal && !run.reviewedAt) ? 'bg-amber-500/10 text-amber-700' : 'bg-surface text-secondary'}`}>
              {statusLabel[run.status]}{terminal ? run.reviewedAt ? ' · 已审阅' : ' · 待审阅' : ''}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-secondary">计划执行于 {dateLabel(run.scheduledAt)} · {run.artifacts.length} 个产物</p>
        </div>
        {isActiveScheduledRun(run) ? <Button type="button" variant="outline" disabled={busy} onClick={onStop}><Square aria-hidden="true" />停止</Button>
          : !run.reviewedAt ? <Button type="button" variant="outline" disabled={busy} onClick={onReview}><Check aria-hidden="true" />标记已审阅</Button> : null}
        {terminal ? <Button type="button" size="icon-sm" variant="ghost" className="text-tertiary hover:text-destructive" aria-label="删除执行记录" title="删除执行记录" disabled={busy} onClick={onDelete}><Trash2 aria-hidden="true" /></Button> : null}
        <Button type="button" size="icon-sm" variant="ghost" className="text-tertiary" onClick={onToggleContextRail}
          aria-controls="workspace-tools" aria-expanded={contextRailOpen}
          aria-label={contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'}
          title={contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'}>
          {contextRailOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
        </Button>
      </div>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8 sm:px-10">
        {run.error ? <p className="mb-6 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{run.error}</p> : null}
        {threadReady ? <div className="min-w-0 max-w-full">
          {turns.map((turn, index) => <TranscriptTurn key={turn.id}
            threadId={threadStore.thread.threadIdentity ?? undefined} turn={turn} turnNumber={index + 1}
            boundary={toTranscriptTurnBoundary(index, Boolean(turns[index - 1]?.failure || turns[index - 1]?.terminalLabel))}
            progress={threadStore.activeTurnProgress?.turnId === turn.id ? threadStore.activeTurnProgress : undefined}
            editableMessageId={threadStore.editableMessageTarget?.turnId === turn.id ? threadStore.editableMessageTarget.messageId : null}
            messageEditor={threadStore.messageEditor} onBeginMessageEdit={threadStore.beginMessageEdit}
            onSetMessageEditDraft={threadStore.setMessageEditDraft} onCancelMessageEdit={threadStore.cancelMessageEdit}
            onSubmitMessageEdit={threadStore.submitMessageEdit} planActionable={false}
            onImplementPlan={threadStore.implementPlan} onRefinePlan={threadStore.refinePlan} />)}
        </div> : <div className="space-y-7">
          <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md border border-link/10 bg-user-message px-4 py-3 text-sm leading-6 text-user-message-foreground">{run.prompt}</div>
          {run.summary ? <AgentMarkdown source={run.summary} isStreaming={false} verifiedFilePaths={run.artifacts} onOpenFile={onOpenArtifact} />
            : isActiveScheduledRun(run) ? <div className="flex items-center gap-2 text-sm text-secondary"><LoaderCircle className="size-4 animate-spin" />任务正在执行…</div>
              : <p className="text-sm text-secondary">本次执行没有生成回复。</p>}
        </div>}

        {run.artifacts.length ? <section className="mt-8 border-t pt-5" aria-label="本次执行产物">
          <h2 className="mb-3 text-xs font-medium text-secondary">本次执行产物</h2>
          <div className="flex flex-wrap gap-2">{run.artifacts.map((file) => <Button key={file} type="button" variant="outline" onClick={() => onOpenArtifact(file)} title={file}><FileText aria-hidden="true" /><span className="max-w-56 truncate">{file.split('/').at(-1)}</span></Button>)}</div>
        </section> : null}
      </div>
    </div>

    {showInteractionFooter ? <footer className="shrink-0 border-t bg-background/95 px-6 py-3 backdrop-blur sm:px-8">
      <div className="mx-auto max-w-4xl">
        {composerSurface === 'approval' ? approvalSurface
          : composerSurface === 'userInput' && userInputTurn?.userInputRequest ? <UserInputSurface
            turnId={userInputTurn.id} request={userInputTurn.userInputRequest} onSubmit={threadStore.respondToUserInput} />
            : <div className="flex items-end gap-2">
              <Textarea value={threadStore.draft} aria-label="继续处理本次执行" placeholder="继续追问或调整本次结果…" rows={1}
                className="min-h-10 max-h-40 resize-y" onChange={(event) => threadStore.setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && threadStore.canSend) { event.preventDefault(); void threadStore.send(); } }} />
              <Button type="button" className="h-10" disabled={!threadStore.canSend} onClick={() => void threadStore.send()}><Send aria-hidden="true" />发送</Button>
            </div>}
      </div>
    </footer> : null}
  </section>;
};
