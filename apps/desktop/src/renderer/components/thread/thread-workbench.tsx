import {
  ArrowUp,
  CircleAlert,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Square,
  X,
} from 'lucide-react';
import { memo, useRef } from 'react';

import { AgentCommentary } from '@/renderer/components/agent/agent-commentary';
import { AgentMessage } from '@/renderer/components/agent/agent-message';
import { CommandApprovalActivity } from '@/renderer/components/agent/command-approval-activity';
import { WorkspaceReadActivity } from '@/renderer/components/agent/workspace-read-activity';
import { WorkspaceListActivity } from '@/renderer/components/agent/workspace-list-activity';
import { WorkspaceSearchActivity } from '@/renderer/components/agent/workspace-search-activity';
import { Button } from '@/renderer/components/ui/button';
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
import { Textarea } from '@/renderer/components/ui/textarea';
import { FileChangeReview } from '@/renderer/components/workspace/file-change-review';
import { McpActivityTimeline } from '@/renderer/components/mcp/activity-timeline';
import { OrchestrationActivity } from '@/renderer/components/orchestration/orchestration-activity';
import { useStore as useWorkspaceNavigationStore } from '@/renderer/components/workspace/navigation/use-store';

import type {
  CompactToolActivity,
  ThreadWorkbenchViewProps,
  TurnActivityViewModel,
  TranscriptMessageViewModel,
  TranscriptTurnProps,
} from './types';
import { resolveConversationTitle } from './conversation-title';
import { ProcessActivityGroup } from './process-activity-group';
import { ThreadNavigator } from './thread-navigator';
import { isCompactToolActivity } from './tool-activity';
import { ToolActivityGroup } from './tool-activity-group';
import { TurnChangeSummary } from './turn-change-summary';
import { toTranscriptTurnBoundary } from './turn-boundary';
import { useStore, useTranscriptFollow } from './use-store';

const TranscriptMessage = ({
  entry,
}: Readonly<{ entry: TranscriptMessageViewModel }>) =>
  entry.role === 'agent' ? (
    <AgentMessage message={entry.message} />
  ) : (
    <div className="ml-auto w-fit max-w-[82%]">
      <article
        className="rounded-2xl rounded-br-md bg-user-message px-4 py-3 text-user-message-foreground"
        aria-label="Your message"
      >
        {entry.message.attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {entry.message.attachments.map((attachment) => (
              <div
                key={attachment.assetId}
                className="flex max-w-56 items-center gap-2 rounded-xl bg-background/70 px-2.5 py-2"
              >
                {attachment.kind === 'image' && attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt=""
                    className="size-8 shrink-0 rounded-md object-cover"
                  />
                ) : attachment.kind === 'image' ? (
                  <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <FileText className="size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate text-xs font-medium">
                  {attachment.originalName}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {entry.message.text ? (
          <p className="whitespace-pre-wrap break-words text-sm font-normal leading-[22px]">
            {entry.message.text}
          </p>
        ) : null}
      </article>
    </div>
  );

const TurnActivity = ({
  entry,
  turnStatus,
}: Readonly<{
  entry: TurnActivityViewModel;
  turnStatus: ThreadWorkbenchViewProps['store']['thread']['turns'][number]['status'];
}>) => {
  switch (entry.type) {
    case 'commentary':
      return <AgentCommentary commentary={entry.activity} />;
    case 'workspaceRead':
      return <WorkspaceReadActivity activity={entry.activity} />;
    case 'workspaceList':
      return <WorkspaceListActivity activity={entry.activity} />;
    case 'workspaceSearch':
      return <WorkspaceSearchActivity activity={entry.activity} />;
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
      return <OrchestrationActivity activity={entry.activity} />;
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
      (entry.type === 'mcp' && entry.activity.state === 'awaiting'),
  );

  return (
    <ProcessActivityGroup
      groupId={activities[0]?.activity.id ?? 'empty-process'}
      status={turnStatus}
      requiresAttention={requiresAttention}
      language={language}
      activeLabel={progress?.label}
      animateActive={progress?.state !== 'uncertain'}
      durationLabel={durationLabel}
    >
      {activities.map((entry, index) => {
        if (!isCompactToolActivity(entry)) {
          return (
            <TurnActivity
              key={`${entry.type}:${entry.activity.id}`}
              entry={entry}
              turnStatus={turnStatus}
            />
          );
        }
        if (isCompactToolActivity(activities[index - 1])) {
          return null;
        }
        const group: CompactToolActivity[] = [];
        for (let cursor = index; cursor < activities.length; cursor += 1) {
          const candidate = activities[cursor];
          if (!isCompactToolActivity(candidate)) {
            break;
          }
          group.push(candidate);
        }
        return (
          <ToolActivityGroup
            key={`toolActivities:${group[0].activity.id}`}
            activities={group}
            language={language}
          />
        );
      })}
    </ProcessActivityGroup>
  );
};

const TranscriptTurnView = ({
  turn,
  turnNumber,
  boundary,
  progress,
}: TranscriptTurnProps) => (
  <section
    aria-label={`第 ${turnNumber} 轮对话`}
    className={`${
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
          <TranscriptMessage key={entry.message.id} entry={entry} />
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
      {turn.status === 'inProgress' &&
      !turn.pendingAgentOutputs?.length &&
      !turn.activities?.length ? (
        <div
          className="flex items-start gap-2 text-sm font-normal text-process"
          role="status"
          aria-live="polite"
        >
          {progress?.state === 'uncertain' ? (
            <CircleAlert className="mt-0.5 size-3.5" aria-hidden="true" />
          ) : null}
          <div className="min-w-0">
            <p
              className={
                progress?.state === 'uncertain'
                  ? undefined
                  : 'agent-status-shimmer'
              }
            >
              {progress?.label ?? '思考中'}
            </p>
            {progress?.detail ? (
              <p className="mt-1 max-w-xl text-xs leading-normal text-secondary">
                {progress.detail}
              </p>
            ) : null}
          </div>
        </div>
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
  <div
    className="space-y-8 py-3"
    role="status"
    aria-label="正在加载目标会话"
  >
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
  contextRailOpen = true,
  contextRailResize,
  onToggleNavigator,
  onToggleContextRail,
  navigationFooter,
  contextRail,
  permissionControl,
  approvalThreadIds = [],
}: ThreadWorkbenchViewProps) => {
  const {
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
  const conversationTitle = resolveConversationTitle(
    store.thread,
    store.navigator,
    workspace.state,
  );
  const conversationSubtitle =
    workspace.state.kind === 'chat'
      ? '独立 Chat'
      : workspace.state.name ?? workspace.state.projectName ?? '项目对话';
  const pendingThreadId = store.navigator.pendingThreadId;
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
            navigatorOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0'
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
            />
          </div>
        </aside>
      {navigatorResize ? (
        <div
          className={`panel-resizer hidden md:block ${
            navigatorResize.dragging ? 'panel-resizer--active' : ''
          } ${
            navigatorOpen ? '' : 'panel-resizer--collapsed'
          }`}
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
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={`window-drag-region relative flex h-[52px] shrink-0 items-center pr-5 transition-[padding] duration-[260ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
            navigatorOpen ? 'pl-5' : 'pl-32'
          }`}
        >
          {onToggleNavigator ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className={`window-no-drag absolute left-[84px] top-1.5 hidden text-tertiary transition-opacity duration-150 md:inline-flex motion-reduce:transition-none ${
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
          <div className="window-no-drag min-w-0 select-text">
            <p
              className="truncate text-sm font-normal tracking-[-0.015em]"
              title={conversationTitle}
            >
              {conversationTitle}
            </p>
            <p className="truncate text-xs font-normal text-tertiary">
              {conversationSubtitle}
            </p>
          </div>
          {contextRail && onToggleContextRail ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="window-no-drag ml-auto hidden text-tertiary min-[1100px]:inline-flex"
              onClick={onToggleContextRail}
              aria-controls="workspace-tools"
              aria-expanded={contextRailOpen}
              aria-label={contextRailOpen ? '关闭右侧工具栏' : '展开右侧工具栏'}
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
          className="relative min-h-0 min-w-0 flex-1"
          onWheel={recordWheelScrollIntent}
          onKeyDown={recordKeyScrollIntent}
          onPointerDown={beginPointerScroll}
          onPointerUp={endPointerScroll}
          onPointerCancel={endPointerScroll}
          viewportProps={{
            'aria-label': 'Conversation transcript',
            tabIndex: 0,
            ref: transcriptViewport,
            onScroll: recordScrollPosition,
          }}
        >
          <div
            ref={transcriptContent}
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-8 pt-8 sm:px-10"
          >
            {pendingThreadId && selectionError ? (
              <ThreadSelectionError
                summary={selectionError}
                onRetry={() => void store.selectThread(pendingThreadId)}
              />
            ) : pendingThreadId ? (
              <ThreadSelectionSkeleton />
            ) : store.thread.isEmpty ? (
              <div className="my-auto py-16 text-center">
                <div className="mx-auto grid size-11 place-items-center rounded-2xl border bg-surface shadow-sm">
                  <span className="text-lg text-secondary" aria-hidden="true">
                    S
                  </span>
                </div>
                <p className="mt-5 text-sm text-secondary">
                  SugarCode · 本地 Agent
                </p>
                <h1 className="mt-3 text-[1.75rem] font-medium leading-[1.2] tracking-[-0.035em]">
                  想让 SugarCode 做什么？
                </h1>
                <p className="mx-auto mt-3 max-w-md text-sm font-normal leading-[22px] text-secondary">
                  描述目标、问题或想完成的改动。项目任务使用项目工作区；聊天不绑定项目，并把需要生成的文件隔离到专属聊天目录。
                </p>
              </div>
            ) : (
              <div>
                {store.thread.turns.map((turn, index) => (
                  <TranscriptTurn
                    key={turn.id}
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
          className="relative z-10 shrink-0 bg-background px-4 pb-4 pt-2 sm:px-8"
        >
          <div className="mx-auto max-w-3xl">
            {(store.actionError || store.thread.notice) && (
              <p className="mb-2 px-1 text-xs text-destructive" role="alert">
                {store.actionError ?? store.thread.notice}
              </p>
            )}
            <div
              className="overflow-hidden rounded-2xl border bg-background shadow-[0_18px_60px_var(--shadow-soft)]"
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
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => {
                  void store.addAttachments(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
              {store.attachments.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto px-3 pt-3">
                  {store.attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="relative flex h-16 min-w-48 max-w-60 items-center gap-2.5 rounded-xl border bg-surface px-2.5 pr-8"
                    >
                      {attachment.previewUrl ? (
                        <img
                          src={attachment.previewUrl}
                          alt=""
                          className="size-11 shrink-0 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-background">
                          <FileText className="size-5 text-secondary" aria-hidden="true" />
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
                        onClick={() => store.removeAttachment(attachment.id)}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              <Textarea
                value={store.draft}
                onChange={(event) => store.setDraft(event.target.value)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files).filter(
                    (file) => file.type.startsWith('image/'),
                  );
                  if (files.length > 0) {
                    event.preventDefault();
                    void store.addAttachments(files);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void store.send();
                  }
                }}
                disabled={
                  store.thread.phase === 'inProgress' ||
                  store.thread.phase === 'stopping' ||
                  store.thread.phase === 'starting' ||
                  store.thread.phase === 'unavailable' ||
                  store.navigator.pendingThreadId !== null
                }
                aria-label="Message SugarCode"
                aria-describedby="conversation-input-hint"
                placeholder="描述你想完成的任务…"
                className="min-h-24 max-h-52 px-4 pt-3.5"
              />
              <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
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
                        className="h-7 w-auto max-w-64 border-0 bg-transparent px-1.5 text-xs shadow-none"
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
                    {permissionControl}
                    <p
                      className={`min-w-0 truncate text-xs ${
                        store.activeTurnProgress?.state === 'uncertain'
                          ? 'text-process'
                          : store.activeTurnProgress
                            ? 'agent-status-shimmer'
                            : 'text-secondary'
                      }`}
                    >
                      {store.activeTurnProgress?.label ??
                        store.thread.statusLabel}
                    </p>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pl-1.5 text-[11px]">
                    <span
                      id="conversation-input-hint"
                      className={
                        store.inputBytes > store.inputLimitBytes
                          ? 'text-destructive'
                          : 'text-tertiary'
                      }
                    >
                      {store.inputHint}
                    </span>
                    {store.contextBudgetHint ? (
                      <>
                        <span className="text-tertiary" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-tertiary">
                          {store.contextBudgetHint}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
                {store.canStop ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void store.stop()}
                    disabled={store.thread.phase === 'stopping'}
                    aria-label="Stop current turn"
                  >
                    <Square
                      className="size-3 fill-current"
                      aria-hidden="true"
                    />
                    {store.thread.phase === 'stopping' ? 'Stopping' : 'Stop'}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    onClick={() => void store.send()}
                    disabled={!store.canSend}
                    aria-label="Send message"
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
      {contextRail ? (
        <>
          {contextRailResize ? (
            <div
              className={`panel-resizer hidden min-[1100px]:block ${
                contextRailResize.dragging ? 'panel-resizer--active' : ''
              } ${
                contextRailOpen ? '' : 'panel-resizer--collapsed'
              }`}
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
            className={`hidden min-h-0 shrink-0 overflow-hidden bg-background min-[1100px]:block ${contextRailTransition} ${
              contextRailOpen
                ? 'opacity-100'
                : 'pointer-events-none opacity-0'
            }`}
            style={{
              width: contextRailOpen ? contextRailTargetWidth : 0,
            }}
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>切换下一轮使用的模型？</AlertDialogTitle>
            <AlertDialogDescription>
              此对话已有持久化 Turn。切换只影响下一轮，不会改写已经完成或正在运行的内容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {store.modelSwitchConfirmation ? (
            <div className="grid gap-2 rounded-xl border bg-surface/50 p-3 text-sm">
              <div className="grid grid-cols-[4rem_1fr] gap-2">
                <span className="text-tertiary">来源</span>
                <span className="min-w-0 break-words">
                  {store.modelSwitchConfirmation.sourceName} ·{' '}
                  <span className="font-mono text-xs text-secondary">
                    {store.modelSwitchConfirmation.sourceWireApi}
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-[4rem_1fr] gap-2">
                <span className="text-tertiary">目标</span>
                <span className="min-w-0 break-words">
                  {store.modelSwitchConfirmation.targetName} ·{' '}
                  <span className="font-mono text-xs text-secondary">
                    {store.modelSwitchConfirmation.targetWireApi}
                  </span>
                </span>
              </div>
              {store.modelSwitchConfirmation.protocolChanges ? (
                <p className="mt-1 text-xs leading-5 text-secondary">
                  Wire API 将发生变化；SugarCode 会把可移植历史转换到目标协议。
                </p>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={store.cancelModelSwitch}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction onClick={store.confirmModelSwitch}>
              确认切换
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
