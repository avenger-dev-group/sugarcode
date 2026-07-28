import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { AgentMessage } from '@/renderer/components/agent/agent-message';
import { Button } from '@/renderer/components/ui/button';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Textarea } from '@/renderer/components/ui/textarea';

import type { ThreadWorkbenchViewProps } from './types';
import { useStore } from './use-store';

export const ThreadWorkbenchView = ({
  store,
}: ThreadWorkbenchViewProps) => {
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'end' });
  }, [store.thread.turns, store.thread.phase]);

  return (
    <section className="relative flex min-h-0 flex-1 flex-col">
      <div className="pointer-events-none absolute inset-0 workbench-grid" />
      <ScrollArea
        className="relative min-h-0 flex-1"
        viewportProps={{
          'aria-label': 'Conversation transcript',
          tabIndex: 0,
        }}
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-44 pt-10 sm:px-10">
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
                <section
                  key={turn.id}
                  className="space-y-7"
                  aria-label={`Turn ${turn.id}`}
                >
                  {turn.messages.map((entry) =>
                    entry.role === 'agent' ? (
                      <AgentMessage
                        key={entry.message.id}
                        message={entry.message}
                      />
                    ) : (
                      <article
                        key={entry.message.id}
                        className="ml-auto max-w-[82%] rounded-2xl rounded-br-md bg-surface px-4 py-3"
                        aria-label="Your message"
                      >
                        <p className="whitespace-pre-wrap break-words text-sm font-normal leading-[22px]">
                          {entry.message.text}
                        </p>
                      </article>
                    ),
                  )}
                  {turn.terminalLabel ? (
                    <p
                      className={`pl-10 font-mono text-[10px] uppercase tracking-[0.14em] ${
                        turn.isError ? 'text-destructive' : 'text-tertiary'
                      }`}
                      role={turn.isError ? 'alert' : 'status'}
                    >
                      {turn.terminalLabel}
                    </p>
                  ) : null}
                </section>
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
                store.thread.phase === 'unavailable'
              }
              aria-label="Message SugarCode"
              aria-describedby="conversation-input-hint"
              placeholder="Describe what you want to work through…"
              className="min-h-24 max-h-52 px-4 pt-3.5"
            />
            <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs text-secondary">
                  {store.thread.statusLabel}
                </p>
                <p
                  id="conversation-input-hint"
                  className={`font-mono text-[10px] ${
                    store.inputBytes > store.inputLimitBytes
                      ? 'text-destructive'
                      : 'text-tertiary'
                  }`}
                >
                  {store.inputHint}
                </p>
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
  );
};

export const ThreadWorkbench = () => {
  const store = useStore();
  return <ThreadWorkbenchView store={store} />;
};
