import {
  ArrowRight,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  FileText,
  Folder,
  Gauge,
  LoaderCircle,
  Paperclip,
  ListOrdered,
  Pencil,
  Trash2,
  Video,
  CornerUpRight,
  Play,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Square,
  X,
} from 'lucide-react';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore as useZustandStore } from 'zustand';

import { AgentMarkdown } from '@/renderer/components/agent/agent-markdown';
import { AgentMessage } from '@/renderer/components/agent/agent-message';
import { CommandApprovalActivity } from '@/renderer/components/agent/command-approval-activity';
import { ComposerInput } from '@/renderer/components/composer/composer-input';
import { WorkspaceReadActivity } from '@/renderer/components/agent/workspace-read-activity';
import { WorkspaceListActivity } from '@/renderer/components/agent/workspace-list-activity';
import { WorkspaceSearchActivity } from '@/renderer/components/agent/workspace-search-activity';
import { Button } from '@/renderer/components/ui/button';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { FileChangeReview } from '@/renderer/components/workspace/file-change-review';
import { TerminalWorkbench } from '@/renderer/components/workspace/terminal/terminal-workbench';
import { McpActivityTimeline } from '@/renderer/components/mcp/activity-timeline';
import {
  AgentTaskDock,
  OrchestrationActivity,
} from '@/renderer/components/orchestration/orchestration-activity';
import { useOrchestrationActions } from '@/renderer/components/orchestration/use-store';
import { useStore as useWorkspaceNavigationStore } from '@/renderer/components/workspace/navigation/use-store';
import { UserInputSurface } from '@/renderer/components/user-input/user-input-surface';
import { UserInputActivity } from '@/renderer/components/user-input/user-input-activity';
import { parseAgentPreviewResponse } from '@/shared/preview-intent';
import { parseComposerSubmission } from '@/shared/composer';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';

import type {
  ThreadWorkbenchViewProps,
  TurnActivityViewModel,
  TranscriptMessageViewModel,
  TranscriptTurnProps,
} from './types';
import {
  canRemoveDraftProject,
  resolveComposerSurface,
} from './composer-state';
import { ContextCompactionActivity } from './context-compaction-activity';
import { ActiveTurnStatus } from './active-turn-status';
import { resolveConversationTitle } from './conversation-title';
import { EmptyThreadState } from './empty-thread-state';
import { ProcessActivityGroup } from './process-activity-group';
import { SkillActivity } from './skill-activity';
import { KnowledgeActivity } from './knowledge-activity';
import { NarrativeActivity } from './narrative-activity';
import { ThreadNavigator } from './thread-navigator';
import { isCompactToolActivity } from './tool-activity';
import { ToolActivityGroup } from './tool-activity-group';
import { TurnChangeSummary } from './turn-change-summary';
import { collectTurnChangeSummaryFiles } from './turn-change-summary-data';
import { toTranscriptTurnBoundary } from './turn-boundary';
import { useStore, useTranscriptFollow } from './use-store';
import { UserMessage } from './user-message';
import { AgentPreviewCard } from './agent-preview-card';
import { GoalRunDock } from './goal-run-dock';
import { AgentDrawioCard } from './agent-drawio-card';

const currentOrchestrationActivity = (
  store: ThreadWorkbenchViewProps['store'],
) => {
  const activeTurnId = store.activeTurnProgress?.turnId;
  const activeTurn = store.thread.turns.find(
    (turn) => turn.id === activeTurnId,
  );
  const activities = activeTurn?.activities ?? [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const entry = activities[index];
    if (entry?.type === 'orchestration') {
      return entry.activity;
    }
  }
  return null;
};

type TranscriptMessageProps = Readonly<{
  entry: TranscriptMessageViewModel;
  threadId?: string;
  turnId?: string;
  goalObjective?: boolean;
  editable?: boolean;
  editor?: ThreadWorkbenchViewProps['store']['messageEditor'];
  onBeginEdit?: ThreadWorkbenchViewProps['store']['beginMessageEdit'];
  onSetEditDraft?: ThreadWorkbenchViewProps['store']['setMessageEditDraft'];
  onCancelEdit?: ThreadWorkbenchViewProps['store']['cancelMessageEdit'];
  onSubmitEdit?: ThreadWorkbenchViewProps['store']['submitMessageEdit'];
}>;

const TranscriptMessage = (props: TranscriptMessageProps) =>
  props.entry.role === 'agent' ? (
    <AgentMessage message={props.entry.message} />
  ) : (
    <UserMessage {...props} entry={props.entry} />
  );

const TurnPreviewOffer = ({
  turn,
}: Readonly<{ turn: TranscriptTurnProps['turn'] }>) => {
  const workspaceKind = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot.kind,
  );
  const finalAgentMessage = turn.messages.findLast(
    (entry) => entry.role === 'agent' && entry.message.state === 'completed',
  );
  const declaredIntent = finalAgentMessage
    ? parseAgentPreviewResponse(finalAgentMessage.message.text).intent
    : null;
  const changedHtmlPath =
    workspaceKind === 'chat'
      ? collectTurnChangeSummaryFiles(turn.activities)
          .map((entry) => entry.file)
          .filter((file) => file.afterBytes > 0 && /\.html?$/iu.test(file.path))
          .sort((left, right) => {
            const leftIndex = /(^|\/)index\.html?$/iu.test(left.path) ? 0 : 1;
            const rightIndex = /(^|\/)index\.html?$/iu.test(right.path) ? 0 : 1;
            return (
              leftIndex - rightIndex ||
              left.path.split('/').length - right.path.split('/').length ||
              left.path.localeCompare(right.path)
            );
          })[0]?.path
      : undefined;
  const intent =
    declaredIntent ??
    (changedHtmlPath
      ? { kind: 'artifact' as const, path: changedHtmlPath }
      : null);
  return intent ? (
    intent.kind === 'drawio' ? (
      <AgentDrawioCard path={intent.path} language={turn.processLanguage} />
    ) : (
      <AgentPreviewCard intent={intent} language={turn.processLanguage} />
    )
  ) : null;
};

const PlanProposal = ({
  planId,
  turnId,
  content,
  actionable,
  onImplement,
  onRefine,
}: Readonly<{
  planId: string;
  turnId: string;
  content: string;
  actionable: boolean;
  onImplement: ThreadWorkbenchViewProps['store']['implementPlan'];
  onRefine: ThreadWorkbenchViewProps['store']['refinePlan'];
}>) => {
  const { openPlan } = useOrchestrationActions();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const showFullPlan = (): void => {
    openPlan({ id: planId, turnId, content });
  };

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) {
      return;
    }
    const update = (): void => {
      setIsTruncated(preview.scrollHeight > preview.clientHeight + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [content]);

  return (
    <article
      className="overflow-hidden rounded-2xl border border-border/80 bg-card/60 shadow-sm"
      aria-label="正式计划"
    >
      <div className="flex items-center gap-2 px-5 pb-3 pt-4">
        <FileText className="size-4 text-process" aria-hidden="true" />
        <span className="text-xs font-medium text-secondary">正式计划</span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-tertiary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={showFullPlan}
          aria-label="在右侧打开完整计划"
        >
          右侧打开
          <ArrowRight className="size-3" aria-hidden="true" />
        </button>
      </div>
      <div className="relative px-5">
        <div
          ref={previewRef}
          className="max-h-[200px] overflow-hidden [&_a]:pointer-events-none [&_button]:pointer-events-none"
          aria-hidden={isTruncated}
          inert={isTruncated ? true : undefined}
        >
          <AgentMarkdown source={content} isStreaming={false} />
        </div>
        {isTruncated ? (
          <div className="plan-preview-frost pointer-events-none absolute inset-x-0 bottom-0 flex h-28 items-end justify-center pb-3">
            <button
              type="button"
              className="pointer-events-auto relative z-10 inline-flex h-9 items-center gap-2 rounded-full bg-white/88 px-4 text-xs font-medium text-[#24272b] shadow-[0_10px_30px_rgba(20,24,32,0.16)] backdrop-blur-xl transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_14px_34px_rgba(20,24,32,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-[#f5f5f5]/92"
              onClick={showFullPlan}
            >
              查看完整计划
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      {actionable ? (
        <div className="mx-5 mt-4 flex flex-wrap justify-end gap-2 border-t border-border/70 pb-4 pt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRefine(turnId)}
          >
            继续完善
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void onImplement(turnId)}
          >
            实现此计划
          </Button>
        </div>
      ) : (
        <div className="h-4" aria-hidden="true" />
      )}
    </article>
  );
};

const QueueDock = ({
  store,
}: Readonly<{ store: ThreadWorkbenchViewProps['store'] }>) => {
  const queue = store.thread.queue;
  if (queue.messages.length === 0) return null;
  const modelLabel = (profileId?: string): string =>
    store.modelOptions.find((option) => option.profileId === profileId)
      ?.label ??
    profileId ??
    '默认模型';
  return (
    <section
      className="mb-2 overflow-hidden rounded-2xl border border-border/80 bg-card/70 shadow-sm backdrop-blur"
      aria-label="待处理消息队列"
    >
      <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <ListOrdered className="size-3.5 text-tertiary" aria-hidden="true" />
        <span className="text-xs font-medium text-secondary">
          队列 · {queue.messages.length}/10
        </span>
        {queue.paused ? (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            已暂停
          </span>
        ) : (
          <span className="text-[11px] text-tertiary">
            当前回合完成后依次执行
          </span>
        )}
        {queue.paused ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-7 gap-1.5 rounded-lg px-2.5 text-xs"
            disabled={store.queueEditor.pendingIds.includes('resume')}
            onClick={() => void store.resumeQueue()}
          >
            {store.queueEditor.pendingIds.includes('resume') ? (
              <LoaderCircle
                className="size-3 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Play className="size-3 fill-current" aria-hidden="true" />
            )}
            继续
          </Button>
        ) : null}
      </header>
      {queue.paused ? (
        <p className="border-b border-border/60 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-tertiary">
          上一回合被停止、失败或中断。新消息仍会加入队尾，点击“继续”后从队首恢复。
        </p>
      ) : null}
      <ol className="max-h-64 divide-y divide-border/60 overflow-y-auto">
        {queue.messages.map((message, index) => {
          const editing = store.queueEditor.itemId === message.id;
          const pending = store.queueEditor.pendingIds.includes(message.id);
          const slashCommand = parseComposerSubmission(
            message.input,
          ).references.some((reference) => reference.kind === 'command');
          const steerable =
            store.thread.phase === 'inProgress' && !slashCommand && !pending;
          return (
            <li key={message.id} className="group px-3 py-2.5">
              {editing ? (
                <div className="space-y-2">
                  <Textarea
                    value={store.queueEditor.draft}
                    onChange={(event) =>
                      store.setQueueEditDraft(event.target.value)
                    }
                    className="min-h-20 resize-y rounded-xl bg-background text-sm"
                    autoFocus
                  />
                  {message.attachments.length > 0 ? (
                    <p className="text-[11px] text-tertiary">
                      已上传附件保持不变；如需更换，请删除此消息后重新发送。
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Select
                      value={store.queueEditor.modelProfileId}
                      onValueChange={store.setQueueEditModel}
                      disabled={pending}
                    >
                      <SelectTrigger className="h-8 max-w-52 text-xs">
                        <SelectValue placeholder="选择模型" />
                      </SelectTrigger>
                      <SelectContent>
                        {store.modelOptions.map((option) => (
                          <SelectItem
                            key={option.profileId}
                            value={option.profileId}
                            disabled={!option.available}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={store.queueEditor.modelRequest.reasoningEffort ?? 'auto'}
                      onValueChange={(value) =>
                        store.setQueueEditReasoningEffort(
                          value as Parameters<typeof store.setQueueEditReasoningEffort>[0],
                        )
                      }
                      disabled={pending}
                    >
                      <SelectTrigger className="h-8 w-28 text-xs" aria-label="队列消息推理强度">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">推理：自动</SelectItem>
                        {(store.modelOptions.find((option) => option.profileId === store.queueEditor.modelProfileId)?.providerFamily ?? 'openai') === 'openai' ? (
                          <>
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="minimal">Minimal</SelectItem>
                          </>
                        ) : null}
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        {(store.modelOptions.find((option) => option.profileId === store.queueEditor.modelProfileId)?.providerFamily ?? 'openai') === 'openai' ? (
                          <SelectItem value="xhigh">XHigh</SelectItem>
                        ) : null}
                        <SelectItem value="max">Max</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={store.queueEditor.modelRequest.serviceTier ?? 'auto'}
                      onValueChange={(value) =>
                        store.setQueueEditServiceTier(
                          value as Parameters<typeof store.setQueueEditServiceTier>[0],
                        )
                      }
                      disabled={pending}
                    >
                      <SelectTrigger className="h-8 w-24 text-xs" aria-label="队列消息服务速度">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">速度：自动</SelectItem>
                        <SelectItem value="standard">标准</SelectItem>
                        <SelectItem value="fast">Fast</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-8"
                      onClick={store.cancelQueueEdit}
                      disabled={pending}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8"
                      onClick={() => void store.saveQueueEdit()}
                      disabled={pending || !store.queueEditor.draft.trim()}
                    >
                      {pending ? (
                        <LoaderCircle
                          className="size-3 animate-spin"
                          aria-hidden="true"
                        />
                      ) : null}
                      保存
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-surface text-[10px] font-semibold text-tertiary">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 whitespace-pre-wrap text-sm text-foreground">
                      {message.input || `${message.attachments.length} 个附件`}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-tertiary">
                      <span>{modelLabel(message.modelProfileId)}</span>
                      {message.modelRequest?.reasoningEffort &&
                      message.modelRequest.reasoningEffort !== 'auto' ? (
                        <span className="rounded-md bg-surface px-1.5 py-0.5">
                          {message.modelRequest.reasoningEffort}
                        </span>
                      ) : null}
                      {message.modelRequest?.serviceTier === 'fast' ? (
                        <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">Fast</span>
                      ) : null}
                      {message.attachments.map((attachment) => (
                        <span
                          key={attachment.assetId}
                          className="max-w-40 truncate rounded-md bg-surface px-1.5 py-0.5"
                        >
                          {attachment.originalName}
                        </span>
                      ))}
                      {slashCommand ? <span>命令将在下一回合执行</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={!steerable}
                      title={
                        slashCommand
                          ? 'Slash Command 只能作为下一回合执行'
                          : '调整当前回合方向'
                      }
                      aria-label="调整方向"
                      onClick={() => void store.steerQueueMessage(message)}
                    >
                      <CornerUpRight className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={pending}
                      aria-label="编辑队列消息"
                      onClick={() => store.beginQueueEdit(message)}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="hover:text-destructive"
                      disabled={pending}
                      aria-label="删除队列消息"
                      onClick={() => void store.deleteQueueMessage(message)}
                    >
                      {pending ? (
                        <LoaderCircle
                          className="size-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};

const TurnActivity = ({
  entry,
  language,
  turnStatus,
}: Readonly<{
  entry: TurnActivityViewModel;
  language: ThreadWorkbenchViewProps['store']['thread']['turns'][number]['processLanguage'];
  turnStatus: ThreadWorkbenchViewProps['store']['thread']['turns'][number]['status'];
}>) => {
  switch (entry.type) {
    case 'commentary':
      return (
        <NarrativeActivity
          activity={entry.activity}
          kind="commentary"
          language={language}
        />
      );
    case 'reasoningSummary':
      return (
        <NarrativeActivity
          activity={entry.activity}
          kind="reasoningSummary"
          language={language}
        />
      );
    case 'workspaceRead':
      return <WorkspaceReadActivity activity={entry.activity} />;
    case 'workspaceList':
      return <WorkspaceListActivity activity={entry.activity} />;
    case 'workspaceSearch':
      return <WorkspaceSearchActivity activity={entry.activity} />;
    case 'skill':
      return <SkillActivity activity={entry.activity} language={language} />;
    case 'knowledge':
      return (
        <KnowledgeActivity activity={entry.activity} language={language} />
      );
    case 'fileChange':
      return <FileChangeReview review={entry.activity} />;
    case 'commandApproval':
      return <CommandApprovalActivity activity={entry.activity} />;
    case 'mcp':
      return (
        <McpActivityTimeline
          activities={[entry.activity]}
          turnStatus={turnStatus}
        />
      );
    case 'orchestration':
      return turnStatus === 'inProgress' ? null : (
        <OrchestrationActivity activity={entry.activity} />
      );
    case 'contextCompaction':
      return <ContextCompactionActivity activity={entry.activity} />;
    case 'userInput':
      return (
        <UserInputActivity activity={entry.activity} language={language} />
      );
  }
};

const TurnActivityTimeline = ({
  activities,
  turnStatus,
  language,
  progress,
  durationLabel,
}: Readonly<{
  activities: readonly TurnActivityViewModel[];
  turnStatus: ThreadWorkbenchViewProps['store']['thread']['turns'][number]['status'];
  language: ThreadWorkbenchViewProps['store']['thread']['turns'][number]['processLanguage'];
  progress?: TranscriptTurnProps['progress'];
  durationLabel?: string;
}>) => {
  const requiresAttention = activities.some(
    (entry) =>
      (entry.type === 'commandApproval' &&
        (entry.activity.state === 'awaiting' ||
          entry.activity.state === 'stopping')) ||
      (entry.type === 'mcp' && entry.activity.state === 'awaiting') ||
      (entry.type === 'userInput' && entry.activity.state === 'awaiting'),
  );
  const toolCount = activities.filter(isCompactToolActivity).length;
  const narrativeCount = activities.filter(
    (entry) => entry.type === 'commentary' || entry.type === 'reasoningSummary',
  ).length;
  const activitySummary = [
    ...(toolCount > 0
      ? [language === 'zh' ? `${toolCount} 个工具` : `${toolCount} tools`]
      : []),
    ...(narrativeCount > 0
      ? [
          language === 'zh'
            ? `${narrativeCount} 段过程`
            : `${narrativeCount} updates`,
        ]
      : []),
  ].join(' · ');

  return (
    <ProcessActivityGroup
      groupId={activities[0]?.activity.id ?? 'empty-process'}
      status={turnStatus}
      requiresAttention={requiresAttention}
      language={language}
      activeLabel={progress?.label}
      animateActive={
        progress?.state !== 'uncertain' && progress?.state !== 'waitingForInput'
      }
      durationLabel={durationLabel}
      activitySummary={activitySummary || undefined}
    >
      {activities.map((entry) => {
        const key = `${entry.type}:${entry.activity.id}`;
        if (!isCompactToolActivity(entry)) {
          return (
            <div
              key={key}
              className="max-h-64 min-w-0 overflow-y-auto overscroll-y-auto pr-1 [scrollbar-gutter:stable]"
            >
              <TurnActivity
                entry={entry}
                language={language}
                turnStatus={turnStatus}
              />
            </div>
          );
        }
        return (
          <div
            key={key}
            className="max-h-64 min-w-0 overflow-y-auto overscroll-y-auto pr-1 [scrollbar-gutter:stable]"
          >
            <ToolActivityGroup activities={[entry]} language={language} />
          </div>
        );
      })}
    </ProcessActivityGroup>
  );
};

const TranscriptTurnView = ({
  threadId,
  turn,
  turnNumber,
  boundary,
  progress,
  editableMessageId,
  messageEditor,
  onBeginMessageEdit,
  onSetMessageEditDraft,
  onCancelMessageEdit,
  onSubmitMessageEdit,
  planActionable,
  onImplementPlan,
  onRefinePlan,
}: TranscriptTurnProps) => (
  <section
    aria-label={`第 ${turnNumber} 轮对话`}
    className={`min-w-0 max-w-full ${
      turn.status === 'inProgress'
        ? ''
        : '[contain-intrinsic-size:auto_240px] [content-visibility:auto]'
    } ${
      boundary === 'divider'
        ? 'mt-8 border-t pt-8'
        : boundary === 'precedingTerminal'
          ? 'mt-8'
          : ''
    }`}
  >
    <div className="space-y-7">
      {turn.messages
        .filter((entry) => entry.role === 'user')
        .map((entry) => (
          <TranscriptMessage
            key={entry.message.id}
            entry={entry}
            threadId={threadId}
            turnId={turn.id}
            goalObjective={turn.origin === 'goal'}
            editable={editableMessageId === entry.message.id}
            editor={
              messageEditor.turnId === turn.id &&
              messageEditor.messageId === entry.message.id
                ? messageEditor
                : undefined
            }
            onBeginEdit={onBeginMessageEdit}
            onSetEditDraft={onSetMessageEditDraft}
            onCancelEdit={onCancelMessageEdit}
            onSubmitEdit={onSubmitMessageEdit}
          />
        ))}
      {turn.activities?.length ? (
        <TurnActivityTimeline
          activities={turn.activities}
          turnStatus={turn.status}
          language={turn.processLanguage}
          progress={progress}
          durationLabel={turn.durationLabel}
        />
      ) : null}
      {!turn.activities && turn.workspaceRead ? (
        <WorkspaceReadActivity activity={turn.workspaceRead} />
      ) : null}
      {!turn.activities && turn.workspaceList ? (
        <WorkspaceListActivity activity={turn.workspaceList} />
      ) : null}
      {!turn.activities && turn.workspaceSearch ? (
        <WorkspaceSearchActivity activity={turn.workspaceSearch} />
      ) : null}
      {!turn.activities && turn.fileChange ? (
        <FileChangeReview review={turn.fileChange} />
      ) : null}
      {!turn.activities && turn.commandApproval ? (
        <CommandApprovalActivity activity={turn.commandApproval} />
      ) : null}
      {!turn.activities && turn.mcpActivities ? (
        <McpActivityTimeline
          activities={turn.mcpActivities}
          turnStatus={turn.status}
        />
      ) : null}
      {turn.pendingAgentOutputs?.map((output) => (
        <AgentMessage key={output.id} message={output} />
      ))}
      {turn.planProposal ? (
        <PlanProposal
          planId={turn.planProposal.id}
          turnId={turn.id}
          content={turn.planProposal.content}
          actionable={planActionable}
          onImplement={onImplementPlan}
          onRefine={onRefinePlan}
        />
      ) : null}
      {turn.messages
        .filter((entry) => entry.role === 'agent')
        .map((entry) => (
          <TranscriptMessage key={entry.message.id} entry={entry} />
        ))}
      {turn.activities && turn.status !== 'inProgress' ? (
        <TurnChangeSummary
          turnId={turn.id}
          activities={turn.activities}
          language={turn.processLanguage}
        />
      ) : null}
      {turn.status === 'completed' ? <TurnPreviewOffer turn={turn} /> : null}
      {turn.status === 'inProgress' && progress ? (
        <ActiveTurnStatus progress={progress} language={turn.processLanguage} />
      ) : null}
      {turn.failure ? (
        <p
          className="flex items-center gap-3 px-4 text-center text-sm font-normal leading-normal text-tertiary before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
          role="alert"
          aria-label="Turn failed"
        >
          {turn.failure.summary}
        </p>
      ) : turn.terminalLabel ? (
        <p
          className={`flex items-center gap-3 text-center text-xs font-normal leading-normal before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border ${
            turn.isError ? 'text-destructive' : 'text-tertiary'
          }`}
          role={turn.isError ? 'alert' : 'status'}
        >
          {turn.terminalLabel}
        </p>
      ) : null}
    </div>
  </section>
);

const TranscriptTurn = memo(TranscriptTurnView);

const ThreadSelectionSkeleton = () => (
  <div className="space-y-8 py-3" role="status" aria-label="正在加载目标会话">
    <div className="ml-auto w-2/3 space-y-2 rounded-2xl rounded-br-md bg-surface p-4">
      <div className="h-3 w-11/12 animate-pulse rounded-full bg-border" />
      <div className="h-3 w-7/12 animate-pulse rounded-full bg-border" />
    </div>
    <div className="w-4/5 space-y-3">
      <div className="h-3 w-2/5 animate-pulse rounded-full bg-surface" />
      <div className="h-3 w-full animate-pulse rounded-full bg-surface" />
      <div className="h-3 w-10/12 animate-pulse rounded-full bg-surface" />
      <div className="h-3 w-7/12 animate-pulse rounded-full bg-surface" />
    </div>
    <span className="sr-only">正在读取会话内容</span>
  </div>
);

const ThreadSelectionError = ({
  summary,
  onRetry,
}: Readonly<{ summary: string; onRetry: () => void }>) => (
  <div
    className="my-auto rounded-2xl border bg-surface p-6 text-center"
    role="alert"
  >
    <CircleAlert
      className="mx-auto size-5 text-destructive"
      aria-hidden="true"
    />
    <p className="mt-3 text-sm font-medium">无法加载此会话</p>
    <p className="mx-auto mt-1 max-w-md text-sm font-normal leading-normal text-secondary">
      {summary}
    </p>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-4"
      onClick={onRetry}
    >
      重试
    </Button>
  </div>
);

export const ThreadWorkbenchView = ({
  store,
  navigatorOpen = true,
  navigatorResize,
  contextRailOpen = false,
  contextRailResize,
  onToggleNavigator,
  onToggleContextRail,
  navigationFooter,
  contextRail,
  permissionControl,
  approvalSurface,
  approvalThreadIds = [],
  mainSurface,
  navigatorSurface = 'workbench',
  onOpenSearch,
  onOpenKnowledge,
  onOpenSkills,
  onOpenWorkbench,
}: ThreadWorkbenchViewProps) => {
  const agentTaskActivity = currentOrchestrationActivity(store);
  const {
    settlingThreadSelection,
    transcriptContent,
    transcriptEnd,
    transcriptViewport,
    recordScrollPosition,
    recordWheelScrollIntent,
    recordKeyScrollIntent,
    beginPointerScroll,
    endPointerScroll,
  } = useTranscriptFollow(store.thread, store.navigator.pendingThreadId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspace = useWorkspaceNavigationStore();
  const composerProjectName =
    workspace.state.status === 'ready' && workspace.state.kind === 'project'
      ? (workspace.state.projectName ?? workspace.state.name)
      : undefined;
  const draftProjectRemovable = canRemoveDraftProject(
    workspace.state,
    store.thread.threadIdentity,
  );
  const conversationTitle = resolveConversationTitle(
    store.thread,
    store.navigator,
    workspace.state,
  );
  const pendingThreadId = store.navigator.pendingThreadId;
  const userInputTurn = store.thread.turns.findLast(
    (turn) => turn.userInputRequest !== undefined,
  );
  const composerSurface = resolveComposerSurface(
    Boolean(approvalSurface),
    Boolean(userInputTurn?.userInputRequest),
  );
  const selectionError = pendingThreadId
    ? store.navigator.selectionNotice
    : undefined;
  const navigatorWidth = navigatorResize?.width ?? 286;
  const contextRailWidth = contextRailResize?.width ?? 760;
  const contextRailTargetWidth = `min(${contextRailWidth}px, 60vw, calc(100vw - 720px))`;
  const navigatorTransition = navigatorResize?.dragging
    ? 'transition-none'
    : 'transition-[width,opacity] duration-[260ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none';
  const contextRailTransition = contextRailResize?.dragging
    ? 'transition-none'
    : 'transition-[width,opacity] duration-[260ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none';

  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside
          id="task-navigator"
          className={`hidden min-h-0 shrink-0 overflow-hidden md:block ${navigatorTransition} ${
            navigatorOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
          style={{ width: navigatorOpen ? navigatorWidth : 0 }}
          aria-hidden={!navigatorOpen}
          inert={navigatorOpen ? undefined : true}
        >
          <div className="h-full" style={{ width: navigatorWidth }}>
            <ThreadNavigator
              store={store}
              footer={navigationFooter}
              onToggleNavigator={onToggleNavigator}
              approvalThreadIds={approvalThreadIds}
              surface={navigatorSurface}
              onOpenSearch={onOpenSearch}
              onOpenKnowledge={onOpenKnowledge}
              onOpenSkills={onOpenSkills}
              onOpenWorkbench={onOpenWorkbench}
            />
          </div>
        </aside>
        {navigatorResize ? (
          <div
            className={`panel-resizer hidden md:block ${
              navigatorResize.dragging ? 'panel-resizer--active' : ''
            } ${navigatorOpen ? '' : 'panel-resizer--collapsed'}`}
            role="separator"
            aria-label="调整任务导航宽度"
            aria-orientation="vertical"
            aria-valuemin={navigatorResize.minWidth}
            aria-valuemax={navigatorResize.maxWidth}
            aria-valuenow={navigatorResize.width}
            tabIndex={0}
            onPointerDown={navigatorResize.onPointerDown}
            onKeyDown={navigatorResize.onKeyDown}
          />
        ) : null}
        <section
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-background ${
            store.thread.isEmpty ? 'empty-thread-workbench' : ''
          }`}
        >
          {mainSurface ? (
            <div
              className="window-no-drag absolute inset-0 z-20 flex min-h-0 flex-col bg-background"
              data-layout="main-surface"
            >
              {mainSurface}
            </div>
          ) : null}
          <header
            className={`${
              mainSurface ? 'window-no-drag' : 'window-drag-region'
            } relative flex h-[52px] shrink-0 items-center border-b border-border-subtle bg-background/88 backdrop-blur-xl transition-[padding] duration-[260ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
              navigatorOpen ? 'pl-5' : 'window-collapsed-header'
            } ${contextRailOpen ? 'pr-5' : 'window-titlebar-trailing-safe'}`}
          >
            {onToggleNavigator ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className={`window-leading-toggle window-no-drag absolute top-1.5 hidden text-tertiary transition-opacity duration-150 md:inline-flex motion-reduce:transition-none ${
                  navigatorOpen
                    ? 'pointer-events-none opacity-0'
                    : 'opacity-100'
                }`}
                onClick={onToggleNavigator}
                aria-controls="task-navigator"
                aria-expanded={navigatorOpen}
                aria-label="展开左侧任务栏"
                title="展开左侧任务栏"
                tabIndex={navigatorOpen ? -1 : 0}
              >
                <PanelLeftOpen aria-hidden="true" />
              </Button>
            ) : null}
            <div className="window-no-drag flex min-w-0 items-center gap-1">
              {composerProjectName ? (
                <div className="group/project flex min-w-0 items-center">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 min-w-0 gap-1.5 rounded-lg px-2 text-sm font-normal text-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={workspace.busy}
                    onClick={() => void workspace.chooseProject()}
                    aria-label={`切换项目文件夹，当前为 ${composerProjectName}`}
                    title="切换项目文件夹"
                  >
                    <Folder
                      className="size-3.5 shrink-0 text-tertiary"
                      aria-hidden="true"
                    />
                    <span className="max-w-48 truncate">
                      {composerProjectName}
                    </span>
                  </Button>
                  {draftProjectRemovable ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="-ml-1 shrink-0 text-tertiary opacity-0 transition-[color,background-color,opacity] hover:text-foreground focus-visible:opacity-100 group-hover/project:opacity-100 group-focus-within/project:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={workspace.busy}
                      onClick={() => void workspace.activateChat()}
                      aria-label={`移除项目 ${composerProjectName} 并切换到工作台`}
                      title="移除项目并切换到工作台"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {composerProjectName && conversationTitle ? (
                <ChevronRight
                  className="size-3.5 shrink-0 text-tertiary/70"
                  aria-hidden="true"
                />
              ) : null}
              {conversationTitle ? (
                <p
                  className="min-w-0 truncate px-1 text-sm font-normal tracking-[-0.015em]"
                  title={conversationTitle}
                >
                  {conversationTitle}
                </p>
              ) : null}
            </div>
            <TerminalWorkbench
              navigatorOffset={
                navigatorOpen ? navigatorWidth + (navigatorResize ? 1 : 0) : 0
              }
            />
            {contextRail && onToggleContextRail ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="window-no-drag ml-1 text-tertiary"
                onClick={onToggleContextRail}
                aria-controls="workspace-tools"
                aria-expanded={contextRailOpen}
                aria-label={
                  contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'
                }
                title={contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'}
              >
                {contextRailOpen ? (
                  <PanelRightClose aria-hidden="true" />
                ) : (
                  <PanelRightOpen aria-hidden="true" />
                )}
              </Button>
            ) : null}
          </header>
          <ScrollArea
            data-layout="conversation-scroll"
            className={`relative min-h-0 min-w-0 flex-1 ${
              store.thread.isEmpty ? 'empty-thread-scroll' : ''
            }`}
            scrollbars={store.thread.isEmpty ? 'none' : 'vertical'}
            onWheel={recordWheelScrollIntent}
            onKeyDown={recordKeyScrollIntent}
            onPointerDown={beginPointerScroll}
            onPointerUp={endPointerScroll}
            onPointerCancel={endPointerScroll}
            viewportProps={{
              'aria-label': 'Conversation transcript',
              className:
                '[&>div]:!block [&>div]:w-full [&>div]:min-w-0 [&>div]:max-w-full',
              tabIndex: 0,
              ref: transcriptViewport,
              onScroll: recordScrollPosition,
            }}
          >
            <div
              ref={transcriptContent}
              className={`mx-auto flex min-h-full w-full min-w-0 max-w-4xl flex-col px-6 pb-8 pt-8 [contain:inline-size] sm:px-10 ${
                store.thread.isEmpty ? 'empty-thread-transcript' : ''
              }`}
            >
              {pendingThreadId && selectionError ? (
                <ThreadSelectionError
                  summary={selectionError}
                  onRetry={() => void store.selectThread(pendingThreadId)}
                />
              ) : pendingThreadId || settlingThreadSelection ? (
                <ThreadSelectionSkeleton />
              ) : store.thread.isEmpty ? (
                <EmptyThreadState
                  onSelectPrompt={store.setDraft}
                  projectName={composerProjectName}
                />
              ) : (
                <div className="min-w-0 max-w-full">
                  {store.thread.turns.map((turn, index) => (
                    <TranscriptTurn
                      key={turn.id}
                      threadId={store.thread.threadIdentity ?? undefined}
                      turn={turn}
                      turnNumber={index + 1}
                      boundary={toTranscriptTurnBoundary(
                        index,
                        Boolean(
                          store.thread.turns[index - 1]?.failure ||
                          store.thread.turns[index - 1]?.terminalLabel,
                        ),
                      )}
                      progress={
                        store.activeTurnProgress?.turnId === turn.id
                          ? store.activeTurnProgress
                          : undefined
                      }
                      editableMessageId={
                        store.editableMessageTarget?.turnId === turn.id
                          ? store.editableMessageTarget.messageId
                          : null
                      }
                      messageEditor={store.messageEditor}
                      onBeginMessageEdit={store.beginMessageEdit}
                      onSetMessageEditDraft={store.setMessageEditDraft}
                      onCancelMessageEdit={store.cancelMessageEdit}
                      onSubmitMessageEdit={store.submitMessageEdit}
                      planActionable={
                        index === store.thread.turns.length - 1 &&
                        turn.status === 'completed' &&
                        store.thread.phase === 'ready' &&
                        !store.isSending
                      }
                      onImplementPlan={store.implementPlan}
                      onRefinePlan={store.refinePlan}
                    />
                  ))}
                </div>
              )}
              {store.isSending || store.thread.phase === 'starting' ? (
                <div
                  className="mt-8 flex items-center gap-2 text-sm font-normal text-process"
                  role="status"
                  aria-live="polite"
                >
                  <LoaderCircle
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  <span>正在提交任务…</span>
                </div>
              ) : null}
              <div ref={transcriptEnd} />
            </div>
          </ScrollArea>

          <div
            data-layout="conversation-composer"
            className={`relative z-10 shrink-0 border-t border-border-subtle bg-background/92 px-4 pb-4 pt-3 backdrop-blur-xl sm:px-8 ${
              store.thread.isEmpty ? 'empty-thread-composer' : ''
            }`}
          >
            <div className="mx-auto max-w-3xl">
              {store.thread.goal ? (
                <GoalRunDock
                  goal={store.thread.goal}
                  busy={store.isSending}
                  progress={
                    store.thread.goal.activeTurnId ===
                    store.activeTurnProgress?.turnId
                      ? store.activeTurnProgress
                      : undefined
                  }
                  onMutate={store.mutateGoal}
                  onStop={store.stop}
                />
              ) : null}
              {agentTaskActivity ? (
                <AgentTaskDock activity={agentTaskActivity} />
              ) : null}
              {composerSurface === 'composer' ? (
                <QueueDock store={store} />
              ) : null}
              {(store.actionError ||
                store.thread.notice ||
                workspace.error) && (
                <p className="mb-2 px-1 text-xs text-destructive" role="alert">
                  {store.actionError ?? store.thread.notice ?? workspace.error}
                </p>
              )}
              {composerSurface === 'approval' ? (
                approvalSurface
              ) : composerSurface === 'userInput' &&
                userInputTurn?.userInputRequest ? (
                <UserInputSurface
                  turnId={userInputTurn.id}
                  request={userInputTurn.userInputRequest}
                  onSubmit={store.respondToUserInput}
                />
              ) : (
                <div
                  className="relative rounded-2xl border border-border-strong bg-surface-raised shadow-[var(--shadow-composer)] transition-[border-color,box-shadow] focus-within:border-ring/70 focus-within:shadow-[0_16px_44px_var(--shadow-soft)] focus-within:ring-3 focus-within:ring-ring/10"
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes('Files')) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => {
                    if (event.dataTransfer.files.length > 0) {
                      event.preventDefault();
                      void store.addAttachments(
                        Array.from(event.dataTransfer.files),
                      );
                    }
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,video/mpeg,application/pdf,text/plain"
                    className="sr-only"
                    tabIndex={-1}
                    onChange={(event) => {
                      void store.addAttachments(
                        Array.from(event.target.files ?? []),
                      );
                      event.target.value = '';
                    }}
                  />
                  {store.attachments.length > 0 ? (
                    <div className="flex gap-2 overflow-x-auto px-3 pt-3">
                      {store.attachments.map((attachment) => (
                        <div
                          key={attachment.id}
                          className="relative flex h-16 min-w-48 max-w-60 items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-2.5 pr-8"
                        >
                          {attachment.previewUrl ? (
                            <img
                              src={attachment.previewUrl}
                              alt=""
                              className="size-11 shrink-0 rounded-lg object-cover"
                            />
                          ) : attachment.mediaType.startsWith('video/') ? (
                            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-background">
                              <Video
                                className="size-5 text-secondary"
                                aria-hidden="true"
                              />
                            </div>
                          ) : (
                            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-background">
                              <FileText
                                className="size-5 text-secondary"
                                aria-hidden="true"
                              />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium">
                              {attachment.fileName}
                            </p>
                            <p className="mt-0.5 text-[11px] text-tertiary">
                              {Math.ceil(attachment.sizeBytes / 1024)} KiB
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="absolute right-1 top-1 size-7"
                            aria-label={`Remove ${attachment.fileName}`}
                            onClick={() =>
                              store.removeAttachment(attachment.id)
                            }
                          >
                            <X className="size-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <ComposerInput
                    value={store.draft}
                    onValueChange={store.setDraft}
                    workspaceGeneration={store.workspaceGeneration}
                    workspaceReady={store.workspaceReady}
                    onPaste={(event) => {
                      const files = Array.from(
                        event.clipboardData.files,
                      ).filter((file) => file.type.startsWith('image/'));
                      if (files.length > 0) {
                        event.preventDefault();
                        void store.addAttachments(files);
                      }
                    }}
                    onSubmit={() => void store.send()}
                    disabled={
                      (store.thread.phase === 'unavailable' &&
                        !store.startsChatOnSend) ||
                      store.isSending ||
                      store.navigator.pendingThreadId !== null
                    }
                  />
                  <div className="flex items-end justify-between gap-3 px-3 pt-1 pb-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          aria-label="Attach files"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={store.modelSelectionDisabled}
                        >
                          <Paperclip className="size-4" aria-hidden="true" />
                        </Button>
                        <Select
                          value={store.selectedModelProfileId}
                          onValueChange={store.setSelectedModelProfileId}
                          disabled={
                            store.modelSelectionDisabled ||
                            store.modelOptions.length === 0
                          }
                        >
                          <SelectTrigger
                            className="h-8 w-auto max-w-56 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-surface"
                            aria-label="Model for next turn"
                          >
                            <SelectValue placeholder="No model configured" />
                          </SelectTrigger>
                          <SelectContent>
                            {store.modelOptions.map((option) => (
                              <SelectItem
                                key={option.profileId}
                                value={option.profileId}
                                disabled={!option.available}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={store.selectedModelRequest.reasoningEffort ?? 'auto'}
                          onValueChange={(value) =>
                            store.setReasoningEffort(
                              value as Parameters<typeof store.setReasoningEffort>[0],
                            )
                          }
                          disabled={store.modelSelectionDisabled}
                        >
                          <SelectTrigger
                            className="h-8 w-auto min-w-24 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-surface"
                            aria-label="Reasoning effort for next turn"
                          >
                            <Gauge className="size-3.5" aria-hidden="true" />
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">自动</SelectItem>
                            {store.selectedModelProviderFamily === 'openai' ? (
                              <>
                                <SelectItem value="none">None</SelectItem>
                                <SelectItem value="minimal">Minimal</SelectItem>
                              </>
                            ) : null}
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            {store.selectedModelProviderFamily === 'openai' ? (
                              <SelectItem value="xhigh">XHigh</SelectItem>
                            ) : null}
                            <SelectItem value="max">Max</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={store.selectedModelRequest.serviceTier ?? 'auto'}
                          onValueChange={(value) =>
                            store.setServiceTier(
                              value as Parameters<typeof store.setServiceTier>[0],
                            )
                          }
                          disabled={store.modelSelectionDisabled}
                        >
                          <SelectTrigger
                            className="h-8 w-auto min-w-20 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-surface"
                            aria-label="Service speed for next turn"
                            title="Fast 可能需要单独开通并产生更高费用"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">自动速度</SelectItem>
                            <SelectItem value="standard">标准</SelectItem>
                            <SelectItem value="fast">Fast</SelectItem>
                          </SelectContent>
                        </Select>
                        {permissionControl}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {store.showStopControl ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void store.stop()}
                          disabled={!store.canStop}
                          aria-label="Stop current turn"
                        >
                          {store.canStop ? (
                            <Square
                              className="size-3 fill-current"
                              aria-hidden="true"
                            />
                          ) : (
                            <LoaderCircle
                              className="size-3 animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          {store.thread.phase === 'stopping'
                            ? 'Stopping'
                            : store.canStop
                              ? 'Stop'
                              : 'Starting'}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="icon"
                        className="size-9 rounded-xl"
                        onClick={() => void store.send()}
                        disabled={!store.canSend}
                        aria-label="Send message"
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
        {contextRail ? (
          <>
            {contextRailOpen && onToggleContextRail ? (
              <button
                type="button"
                className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px] min-[1100px]:hidden"
                onClick={onToggleContextRail}
                aria-label="关闭右侧工具栏"
              />
            ) : null}
            {contextRailResize ? (
              <div
                className={`panel-resizer hidden min-[1100px]:block ${
                  contextRailResize.dragging ? 'panel-resizer--active' : ''
                } ${contextRailOpen ? '' : 'panel-resizer--collapsed'}`}
                role="separator"
                aria-label="调整上下文栏宽度"
                aria-orientation="vertical"
                aria-valuemin={contextRailResize.minWidth}
                aria-valuemax={contextRailResize.maxWidth}
                aria-valuenow={contextRailResize.width}
                tabIndex={0}
                onPointerDown={contextRailResize.onPointerDown}
                onKeyDown={contextRailResize.onKeyDown}
              />
            ) : null}
            <aside
              id="workspace-tools"
              className={`fixed inset-y-0 right-0 z-40 block min-h-0 shrink-0 overflow-hidden border-l border-border-subtle bg-background shadow-[-24px_0_64px_var(--shadow-soft)] [width:var(--context-rail-mobile-width)] min-[1100px]:static min-[1100px]:z-auto min-[1100px]:shadow-none min-[1100px]:[width:var(--context-rail-desktop-width)] ${contextRailTransition} ${
                contextRailOpen
                  ? 'opacity-100'
                  : 'pointer-events-none opacity-0'
              }`}
              style={
                {
                  '--context-rail-mobile-width': contextRailOpen
                    ? `min(${contextRailWidth}px, calc(100vw - 1rem))`
                    : '0px',
                  '--context-rail-desktop-width': contextRailOpen
                    ? contextRailTargetWidth
                    : '0px',
                } as CSSProperties
              }
              aria-label="Workspace tools"
              aria-hidden={!contextRailOpen}
              inert={contextRailOpen ? undefined : true}
            >
              <div className="h-full w-full">{contextRail}</div>
            </aside>
          </>
        ) : null}
      </div>
      <AlertDialog
        open={store.modelSwitchConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) store.cancelModelSwitch();
        }}
      >
        <AlertDialogContent className="max-w-xl grid-rows-[auto_minmax(0,1fr)_auto]">
          <div className="border-b px-5 py-4 sm:px-6">
            <AlertDialogHeader>
              <AlertDialogTitle>切换模型？</AlertDialogTitle>
              <AlertDialogDescription>
                新模型将从下一条消息开始使用，已有对话内容不会改变。
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            {store.modelSwitchConfirmation ? (
              <div className="rounded-lg border bg-surface p-4">
                <dl className="grid gap-4 text-sm">
                  <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3">
                    <dt className="text-secondary">当前</dt>
                    <dd className="min-w-0">
                      <p className="break-words font-medium text-foreground">
                        {store.modelSwitchConfirmation.sourceName}
                      </p>
                    </dd>
                  </div>
                  <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3">
                    <dt className="text-secondary">切换为</dt>
                    <dd className="min-w-0">
                      <p className="break-words font-medium text-foreground">
                        {store.modelSwitchConfirmation.targetName}
                      </p>
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </div>
          <AlertDialogFooter className="border-t bg-surface px-5 py-4 sm:items-center sm:px-6">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button type="button" onClick={store.confirmModelSwitch}>
                确认切换
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export const ThreadWorkbench = () => {
  const store = useStore();
  return <ThreadWorkbenchView store={store} />;
};
