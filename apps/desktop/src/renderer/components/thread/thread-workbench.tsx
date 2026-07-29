import { ArrowUp, PanelLeft, Square } from 'lucide-react';
import { memo } from 'react';

import { AgentMessage } from '@/renderer/components/agent/agent-message';
import { CommandApprovalActivity } from '@/renderer/components/agent/command-approval-activity';
import { WorkspaceReadActivity } from '@/renderer/components/agent/workspace-read-activity';
import { WorkspaceListActivity } from '@/renderer/components/agent/workspace-list-activity';
import { WorkspaceSearchActivity } from '@/renderer/components/agent/workspace-search-activity';
import { Button } from '@/renderer/components/ui/button';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Textarea } from '@/renderer/components/ui/textarea';
import { FileChangeReview } from '@/renderer/components/workspace/file-change-review';
import { McpActivityTimeline } from '@/renderer/components/mcp/activity-timeline';

import type {
  ThreadWorkbenchViewProps,
  TranscriptMessageViewModel,
  TranscriptTurnProps,
} from './types';
import { ThreadNavigator } from './thread-navigator';
import { useStore, useTranscriptFollow } from './use-store';

const TranscriptMessage = ({
  entry,
}: Readonly<{ entry: TranscriptMessageViewModel }>) =>
  entry.role === 'agent' ? (
    <div>
      <p
        className="mb-2 min-w-0 break-all pl-10 font-mono text-[10px] tracking-[0.08em] text-tertiary"
        aria-label={`Durable Item ${entry.message.id}`}
      >
        Item {entry.message.id}
      </p>
      <AgentMessage message={entry.message} />
    </div>
  ) : (
    <div className="ml-auto max-w-[82%]">
      <p
        className="mb-2 min-w-0 break-all text-right font-mono text-[10px] tracking-[0.08em] text-tertiary"
        aria-label={`Durable Item ${entry.message.id}`}
      >
        Item {entry.message.id}
      </p>
      <article
        className="rounded-2xl rounded-br-md bg-surface px-4 py-3"
        aria-label="Your message"
      >
        <p className="whitespace-pre-wrap break-words text-sm font-normal leading-[22px]">
          {entry.message.text}
        </p>
      </article>
    </div>
  );

const TranscriptTurnView = ({ turn }: TranscriptTurnProps) => (
  <section
    className={
      turn.status === 'inProgress'
        ? ''
        : '[contain-intrinsic-size:auto_240px] [content-visibility:auto]'
    }
    aria-label={`Durable Turn ${turn.id}`}
  >
    <p
      className="min-w-0 break-all font-mono text-[10px] tracking-[0.08em] text-tertiary"
      aria-hidden="true"
    >
      Turn {turn.id}
    </p>
    <div className="mt-3 space-y-7">
      {turn.messages
        .filter((entry) => entry.role === 'user')
        .map((entry) => (
          <TranscriptMessage key={entry.message.id} entry={entry} />
        ))}
      {turn.workspaceRead ? (
        <WorkspaceReadActivity activity={turn.workspaceRead} />
      ) : null}
      {turn.workspaceList ? (
        <WorkspaceListActivity activity={turn.workspaceList} />
      ) : null}
      {turn.workspaceSearch ? (
        <WorkspaceSearchActivity activity={turn.workspaceSearch} />
      ) : null}
      {turn.fileChange ? (
        <FileChangeReview review={turn.fileChange} />
      ) : null}
      {turn.commandApproval ? (
        <CommandApprovalActivity activity={turn.commandApproval} />
      ) : null}
      {turn.mcpActivities ? (
        <McpActivityTimeline
          activities={turn.mcpActivities}
          turnStatus={turn.status}
        />
      ) : null}
      {turn.messages
        .filter((entry) => entry.role === 'agent')
        .map((entry) => (
          <TranscriptMessage key={entry.message.id} entry={entry} />
        ))}
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
}: ThreadWorkbenchViewProps) => {
  const { transcriptEnd, recordScrollPosition } = useTranscriptFollow(
    store.thread,
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <aside className="hidden min-h-0 w-60 shrink-0 md:block">
        <ThreadNavigator store={store} />
      </aside>
      {store.navigatorOpen ? (
        <div className="h-[45vh] min-h-56 shrink-0 border-b md:hidden">
          <ThreadNavigator id="thread-navigator" store={store} />
        </div>
      ) : null}
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="pointer-events-none absolute inset-0 workbench-grid" />
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
      <ScrollArea
        className="relative min-h-0 min-w-0 flex-1"
        viewportProps={{
          'aria-label': 'Conversation transcript',
          tabIndex: 0,
          onScroll: recordScrollPosition,
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-44 pt-16 sm:px-10 md:pt-10">
          {store.thread.isEmpty ? (
            <div className="my-auto max-w-xl py-16">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-tertiary">
                Text Agent · local runtime
              </p>
              <h1 className="mt-4 max-w-lg text-[2rem] font-medium leading-[1.1] tracking-[-0.04em]">
                Start with the problem,
                <br />
                not the ceremony.
              </h1>
              <p className="mt-5 max-w-md text-sm font-normal leading-[22px] text-secondary">
                One durable Thread. Your message is recorded by Core before it
                appears here, and the response streams back from the local
                SugarCode runtime.
              </p>
            </div>
          ) : (
            <div className="space-y-10">
              {store.thread.turns.map((turn) => (
                <TranscriptTurn key={turn.id} turn={turn} />
              ))}
            </div>
          )}
          <div ref={transcriptEnd} />
        </div>
      </ScrollArea>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-5 pt-12 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {(store.actionError || store.thread.notice) && (
            <p
              className="mb-2 px-1 text-xs text-destructive"
              role="alert"
            >
              {store.actionError ?? store.thread.notice}
            </p>
          )}
          <div className="overflow-hidden rounded-2xl border bg-background shadow-[0_18px_60px_var(--shadow-soft)]">
            <Textarea
              value={store.draft}
              onChange={(event) => store.setDraft(event.target.value)}
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
              placeholder="Describe what you want to work through…"
              className="min-h-24 max-h-52 px-4 pt-3.5"
            />
            <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-secondary">
                  {store.thread.statusLabel}
                </p>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[10px]">
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
                  <span className="text-tertiary" aria-hidden="true">
                    ·
                  </span>
                  <span
                    className="min-w-0 break-all text-tertiary"
                    aria-label={
                      store.thread.threadIdentity
                        ? `Current durable Thread ${store.thread.threadIdentity}`
                        : 'No durable Thread yet'
                    }
                  >
                    {store.thread.threadIdentity
                      ? `Thread ${store.thread.threadIdentity}`
                      : 'Thread not created'}
                  </span>
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
                  <Square className="size-3 fill-current" aria-hidden="true" />
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
          <p className="mt-2 text-center text-[11px] text-tertiary">
            Enter to send · Shift+Enter for a new line
          </p>
        </div>
      </div>
      </section>
    </div>
  );
};

export const ThreadWorkbench = () => {
  const store = useStore();
  return <ThreadWorkbenchView store={store} />;
};
