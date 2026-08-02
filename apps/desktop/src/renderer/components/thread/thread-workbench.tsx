import {
  ArrowUp,
  CircleAlert,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { memo, useRef } from 'react';

import { AgentCommentary } from '@/renderer/components/agent/agent-commentary';
import { AgentMessage } from '@/renderer/components/agent/agent-message';
import { CommandApprovalActivity } from '@/renderer/components/agent/command-approval-activity';
import { ContextCompactionActivity } from '@/renderer/components/agent/context-compaction-activity';
import { WorkspaceReadActivity } from '@/renderer/components/agent/workspace-read-activity';
import { WorkspaceListActivity } from '@/renderer/components/agent/workspace-list-activity';
import { WorkspaceSearchActivity } from '@/renderer/components/agent/workspace-search-activity';
import { Button } from '@/renderer/components/ui/button';
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

import type {
  CompactToolActivity,
  ThreadWorkbenchViewProps,
  TurnActivityViewModel,
  TranscriptMessageViewModel,
  TranscriptTurnProps,
} from './types';
import { ProcessActivityGroup } from './process-activity-group';
import { ThreadNavigator } from './thread-navigator';
import { isCompactToolActivity } from './tool-activity';
import { ToolActivityGroup } from './tool-activity-group';
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
    case 'contextCompaction':
      return <ContextCompactionActivity activity={entry.activity} />;
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
}: Readonly<{
  activities: readonly TurnActivityViewModel[];
  turnStatus: ThreadWorkbenchViewProps['store']['thread']['turns'][number]['status'];
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
          />
        );
      })}
    </ProcessActivityGroup>
  );
};

const TranscriptTurnView = ({ turn, progress, onStop }: TranscriptTurnProps) => (
  <section
    className={
      turn.status === 'inProgress'
        ? ''
        : '[contain-intrinsic-size:auto_240px] [content-visibility:auto]'
    }
  >
    <div className="space-y-7">
      {turn.messages
        .filter((entry) => entry.role === 'user')
        .map((entry) => (
          <TranscriptMessage key={entry.message.id} entry={entry} />
        ))}
      {turn.activities ? (
        <TurnActivityTimeline
          activities={turn.activities}
          turnStatus={turn.status}
        />
      ) : null}
      {!turn.activities &&
        turn.contextCompactions?.map((activity) => (
          <ContextCompactionActivity key={activity.id} activity={activity} />
        ))}
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
      {turn.status === 'inProgress' &&
      !turn.pendingAgentOutputs?.length ? (
        <div
          className="flex items-start gap-2 text-sm font-normal text-process"
          role="status"
          aria-live="polite"
        >
          {progress?.state === 'uncertain' ? (
            <CircleAlert className="mt-0.5 size-3.5" aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="mt-0.5 size-3.5 animate-spin"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <p>
              {progress?.label ?? 'Agent 正在处理…'}
              {progress?.elapsedLabel ? (
                <span aria-hidden="true"> · {progress.elapsedLabel}</span>
              ) : null}
            </p>
            {progress?.detail ? (
              <p className="mt-1 max-w-xl text-xs leading-normal text-secondary">
                {progress.detail}
              </p>
            ) : null}
            {progress?.state === 'waitingForModel' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={onStop}
                aria-label="停止当前任务"
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
                停止任务
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {turn.failure ? (
        <div
          className="ml-10 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
          role="alert"
          aria-label="Turn failure details"
        >
          <p className="text-sm font-medium text-destructive">
            {turn.failure.summary}
          </p>
          <p className="mt-1 text-sm font-normal leading-normal text-secondary">
            {turn.failure.guidance}
          </p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px] text-tertiary">
            {turn.model ? (
              <>
                <span className="uppercase tracking-[0.14em]">Model</span>
                <span className="min-w-0 break-all tracking-[0.08em]">
                  {turn.model.displayName} · {turn.model.wireApi}
                </span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span className="uppercase tracking-[0.14em]">Failure kind</span>
            <span
              aria-label={`Exact Turn failure kind ${turn.failure.kind}`}
              className="min-w-0 break-all tracking-[0.08em]"
            >
              {turn.failure.kind}
            </span>
            <span aria-hidden="true">·</span>
            <span className="uppercase tracking-[0.14em]">
              {turn.failure.retryable
                ? 'Retryable failure'
                : 'Not automatically retryable'}
            </span>
          </div>
        </div>
      ) : turn.terminalLabel ? (
        <p
          className={`pl-10 font-mono text-[10px] uppercase tracking-[0.14em] ${
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

export const ThreadWorkbenchView = ({
  store,
  navigatorResize,
  contextRailResize,
  navigationFooter,
  contextRail,
  contextRailOpen = false,
  setContextRailOpen,
  navigatorVisible = true,
  setNavigatorVisible,
  contextRailVisible = true,
  setContextRailVisible,
  permissionControl,
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
  } = useTranscriptFollow(store.thread);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <aside
        className={
          navigatorVisible
            ? 'hidden min-h-0 shrink-0 md:block'
            : 'hidden'
        }
        style={{ width: navigatorResize?.width ?? 248 }}
      >
        <ThreadNavigator store={store} footer={navigationFooter} />
      </aside>
      {navigatorResize && navigatorVisible ? (
        <div
          className={`panel-resizer hidden md:block ${
            navigatorResize.dragging ? 'panel-resizer--active' : ''
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
      {store.navigatorOpen ? (
        <div className="absolute inset-x-0 top-0 z-20 h-[45vh] min-h-56 border-b shadow-xl md:hidden">
          <ThreadNavigator
            id="thread-navigator"
            store={store}
            footer={navigationFooter}
          />
        </div>
      ) : null}
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="absolute left-3 top-3 z-10 bg-background/90 shadow-sm md:hidden"
          aria-label={
            store.navigatorOpen
              ? 'Hide Thread navigator'
              : 'Show Thread navigator'
          }
          aria-controls="thread-navigator"
          aria-expanded={store.navigatorOpen}
          onClick={() => store.setNavigatorOpen(!store.navigatorOpen)}
        >
          <PanelLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="absolute left-3 top-3 z-10 hidden bg-background/90 shadow-sm md:inline-flex"
          aria-label={
            navigatorVisible
              ? 'Collapse Thread navigator'
              : 'Expand Thread navigator'
          }
          aria-pressed={navigatorVisible}
          onClick={() => setNavigatorVisible?.(!navigatorVisible)}
        >
          <PanelLeft aria-hidden="true" />
        </Button>
        {contextRail ? (
          <>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="absolute right-3 top-3 z-10 bg-background/90 shadow-sm xl:hidden"
              aria-label={
                contextRailOpen
                  ? 'Hide workspace tools'
                  : 'Show workspace tools'
              }
              aria-controls="workspace-tools"
              aria-expanded={contextRailOpen}
              onClick={() => setContextRailOpen?.(!contextRailOpen)}
            >
              <PanelRight aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="absolute right-3 top-3 z-10 hidden bg-background/90 shadow-sm xl:inline-flex"
              aria-label={
                contextRailVisible
                  ? 'Collapse workspace tools'
                  : 'Expand workspace tools'
              }
              aria-pressed={contextRailVisible}
              onClick={() =>
                setContextRailVisible?.(!contextRailVisible)
              }
            >
              <PanelRight aria-hidden="true" />
            </Button>
          </>
        ) : null}
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
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-8 pt-16 sm:px-10 md:pt-10"
          >
            {store.thread.isEmpty ? (
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
              <div className="space-y-10">
                {store.thread.turns.map((turn) => (
                  <TranscriptTurn
                    key={turn.id}
                    turn={turn}
                    progress={
                      store.activeTurnProgress?.turnId === turn.id
                        ? store.activeTurnProgress
                        : undefined
                    }
                    onStop={() => void store.stop()}
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
                      value={store.selectedModelProfileId || undefined}
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
                    <p className="min-w-0 truncate text-xs text-secondary">
                      {store.activeTurnProgress
                        ? `${store.activeTurnProgress.label}${
                            store.activeTurnProgress.elapsedLabel
                              ? ` · ${store.activeTurnProgress.elapsedLabel}`
                              : ''
                          }`
                        : store.thread.statusLabel}
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
          {contextRailResize && contextRailVisible ? (
            <div
              className={`panel-resizer hidden xl:block ${
                contextRailResize.dragging ? 'panel-resizer--active' : ''
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
            className={`fixed inset-y-0 right-0 z-30 min-h-0 max-w-[92vw] overflow-hidden border-l bg-background shadow-[-18px_0_50px_var(--shadow-soft)] transition-transform duration-150 motion-reduce:transition-none xl:static xl:z-auto xl:visible xl:shrink-0 xl:translate-x-0 xl:border-l-0 xl:shadow-none ${
              contextRailOpen
                ? 'visible translate-x-0'
                : 'invisible translate-x-full'
            } ${
              contextRailVisible
                ? 'xl:visible xl:block xl:translate-x-0'
                : 'xl:hidden'
            }`}
            style={{ width: contextRailResize?.width ?? 352 }}
            aria-label="Workspace tools"
          >
            {contextRail}
          </aside>
        </>
      ) : null}
    </div>
  );
};

export const ThreadWorkbench = () => {
  const store = useStore();
  return <ThreadWorkbenchView store={store} />;
};
