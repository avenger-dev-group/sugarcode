import {
  Archive,
  GitFork,
  LoaderCircle,
  MessageSquareText,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

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
import { Input } from '@/renderer/components/ui/input';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { McpSessionPanel } from '@/renderer/components/mcp/session-panel';

import type { ThreadStore } from './types';

type ThreadNavigatorProps = Readonly<{
  store: ThreadStore;
  id?: string;
}>;

const focusThreadAt = (
  container: HTMLElement,
  index: number,
): void => {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-thread-button]'),
  );
  buttons.at(index)?.focus();
};

export const ThreadNavigator = ({ store, id }: ThreadNavigatorProps) => {
  const [query, setQuery] = useState(store.navigator.query);
  const [deleteThreadId, setDeleteThreadId] = useState<string | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const searchDisabled =
    store.navigator.status === 'unavailable' ||
    store.navigator.status === 'loading' ||
    Boolean(store.navigator.pendingMutation);
  const selectionDisabled =
    searchDisabled ||
    store.navigator.searchStatus === 'loading' ||
    store.thread.phase === 'starting' ||
    store.thread.phase === 'inProgress' ||
    store.thread.phase === 'stopping';

  useEffect(() => {
    setQuery(store.navigator.query);
  }, [store.navigator.query]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void store.searchThreads(query);
  };

  const handleListKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[data-thread-button]',
      ),
    );
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (buttons.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusThreadAt(event.currentTarget, (current + 1) % buttons.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusThreadAt(
        event.currentTarget,
        (current - 1 + buttons.length) % buttons.length,
      );
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusThreadAt(event.currentTarget, 0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusThreadAt(event.currentTarget, -1);
    }
  };

  const currentOutsideResults =
    store.navigator.selectedThreadId &&
    !store.navigator.threadIds.includes(store.navigator.selectedThreadId);

  return (
    <>
      <nav
      id={id}
      aria-label="Threads"
      className="flex h-full min-h-0 w-full flex-col border-r bg-surface/45"
      onKeyDown={(event) => {
        if (id && event.key === 'Escape') {
          store.setNavigatorOpen(false);
          document
            .querySelector<HTMLButtonElement>(
              '[aria-controls="thread-navigator"]',
            )
            ?.focus();
        }
      }}
    >
      <div className="border-b px-4 pb-4 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-tertiary">
              Durable index
            </p>
            <h2 className="mt-1 text-sm font-medium">Threads</h2>
          </div>
          <span className="font-mono text-[10px] text-tertiary">
            {store.navigator.threadIds.length}/50
          </span>
        </div>
        <form className="mt-4 flex gap-2" onSubmit={submit}>
          <label htmlFor="thread-search" className="sr-only">
            Search Threads
          </label>
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-tertiary"
              aria-hidden="true"
            />
            <Input
              id="thread-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={searchDisabled}
              maxLength={256}
              placeholder="Search durable replies"
              className="pl-8 pr-8"
            />
            {query ? (
              <button
                type="button"
                className="absolute right-2 top-2 rounded p-0.5 text-tertiary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Clear Thread search"
                onClick={() => {
                  setQuery('');
                  void store.searchThreads('');
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <Button
            type="submit"
            size="icon"
            variant="outline"
            disabled={searchDisabled || query.trim().length === 0}
            aria-label="Search Threads"
          >
            {store.navigator.searchStatus === 'loading' ? (
              <LoaderCircle
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Search aria-hidden="true" />
            )}
          </Button>
        </form>
      </div>

      <p
        className="border-b px-4 py-2 text-[11px] leading-4 text-secondary"
        role={
          store.navigator.searchStatus === 'error' ? 'alert' : 'status'
        }
        aria-live="polite"
      >
        {store.navigator.statusLabel}
        {store.navigator.truncated ? ' · First 50 shown' : ''}
        {!store.navigator.archivedUndoThreadId &&
        store.navigator.mutationNotice
          ? ` · ${store.navigator.mutationNotice}`
          : ''}
      </p>

      <ScrollArea className="min-h-0 flex-1">
        <div
          ref={listRef}
          className="space-y-1 p-2"
          onKeyDown={handleListKeyDown}
        >
          {currentOutsideResults ? (
            <>
              <p className="px-2 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.15em] text-tertiary">
                Current
              </p>
              <ThreadButton
                threadId={store.navigator.selectedThreadId as string}
                current
                pending={false}
                disabled={selectionDisabled}
                onSelect={store.selectThread}
                onFork={store.forkThread}
                onArchive={store.archiveThread}
                onRequestDelete={setDeleteThreadId}
                pendingMutation={store.navigator.pendingMutation}
              />
              <p className="px-2 pb-1 pt-4 font-mono text-[9px] uppercase tracking-[0.15em] text-tertiary">
                {store.navigator.searchStatus === 'idle'
                  ? 'Active'
                  : 'Matches'}
              </p>
            </>
          ) : null}
          {store.navigator.threadIds.map((threadId) => (
            <ThreadButton
              key={threadId}
              threadId={threadId}
              current={threadId === store.navigator.selectedThreadId}
              pending={threadId === store.navigator.pendingThreadId}
              disabled={selectionDisabled}
              onSelect={store.selectThread}
              onFork={store.forkThread}
              onArchive={store.archiveThread}
              onRequestDelete={setDeleteThreadId}
              pendingMutation={store.navigator.pendingMutation}
            />
          ))}
          {store.navigator.threadIds.length === 0 &&
          store.navigator.searchStatus !== 'loading' ? (
            <div className="px-3 py-10 text-center">
              <MessageSquareText
                className="mx-auto size-5 text-tertiary"
                aria-hidden="true"
              />
              <p className="mt-3 text-xs leading-5 text-secondary">
                {store.navigator.searchStatus === 'empty'
                  ? 'No active Thread contains every search term.'
                  : 'No active Threads yet.'}
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {store.navigator.selectionNotice ? (
        <p className="border-t px-4 py-3 text-xs text-destructive" role="alert">
          {store.navigator.selectionNotice}
        </p>
      ) : null}
      {store.navigator.archivedUndoThreadId ? (
        <div
          className="flex items-center gap-2 border-t px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <p className="min-w-0 flex-1 text-xs leading-5 text-secondary">
            Thread archived. Undo remains available until the next
            lifecycle action or reconnect.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(store.navigator.pendingMutation)}
            onClick={() =>
              void store.unarchiveThread(
                store.navigator.archivedUndoThreadId as string,
              )
            }
          >
            <RotateCcw aria-hidden="true" />
            Undo
          </Button>
        </div>
      ) : null}
      <div className="max-h-[45%] shrink-0 overflow-y-auto">
        <McpSessionPanel
          turnBusy={
            store.thread.phase === 'starting' ||
            store.thread.phase === 'inProgress' ||
            store.thread.phase === 'stopping'
          }
        />
      </div>
      </nav>

      <AlertDialog
        open={deleteThreadId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteThreadId(null);
          }
        }}
      >
        <AlertDialogContent
          className="max-w-md p-5"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelDeleteRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete durable Thread?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the Thread from the local Agent.
              Archive it instead if you may need it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="mt-4 break-all rounded-md border bg-surface/60 p-3 font-mono text-[10px] leading-4 text-secondary">
            {deleteThreadId}
          </p>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel asChild>
              <Button
                ref={cancelDeleteRef}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (deleteThreadId) {
                    void store.deleteThread(deleteThreadId);
                  }
                }}
              >
                Delete permanently
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

type ThreadButtonProps = Readonly<{
  threadId: string;
  current: boolean;
  pending: boolean;
  disabled: boolean;
  pendingMutation: ThreadStore['navigator']['pendingMutation'];
  onSelect: (threadId: string) => Promise<void>;
  onFork: (threadId: string) => Promise<void>;
  onArchive: (threadId: string) => Promise<void>;
  onRequestDelete: (threadId: string) => void;
}>;

const ThreadButton = ({
  threadId,
  current,
  pending,
  disabled,
  pendingMutation,
  onSelect,
  onFork,
  onArchive,
  onRequestDelete,
}: ThreadButtonProps) => (
  <div
    className={`group flex min-w-0 items-stretch rounded-lg border transition-colors ${
      current
        ? 'border-primary/25 bg-primary/10 text-foreground'
        : 'border-transparent text-secondary hover:border-border hover:bg-background hover:text-foreground'
    }`}
  >
    <button
      type="button"
      data-thread-button
      aria-current={current ? 'page' : undefined}
      aria-label={`${current ? 'Current ' : ''}Thread ${threadId}`}
      disabled={disabled}
      onClick={() => void onSelect(threadId)}
      className="flex min-w-0 flex-1 items-start gap-2 rounded-l-lg px-2.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? (
        <LoaderCircle
          className="mt-0.5 size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : (
        <span
          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
            current ? 'bg-primary' : 'bg-tertiary'
          }`}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 break-all font-mono text-[10px] leading-4 tracking-[0.04em]">
        {threadId}
      </span>
    </button>
    <div className="flex shrink-0 items-center pr-1">
      <ThreadActionButton
        label={`Fork Thread ${threadId}`}
        active={
          pendingMutation?.kind === 'fork' &&
          pendingMutation.threadId === threadId
        }
        disabled={disabled}
        onClick={() => void onFork(threadId)}
      >
        <GitFork aria-hidden="true" />
      </ThreadActionButton>
      <ThreadActionButton
        label={`Archive Thread ${threadId}`}
        active={
          pendingMutation?.kind === 'archive' &&
          pendingMutation.threadId === threadId
        }
        disabled={disabled}
        onClick={() => void onArchive(threadId)}
      >
        <Archive aria-hidden="true" />
      </ThreadActionButton>
      <ThreadActionButton
        label={`Delete Thread ${threadId}`}
        active={
          pendingMutation?.kind === 'delete' &&
          pendingMutation.threadId === threadId
        }
        disabled={disabled}
        destructive
        onClick={() => onRequestDelete(threadId)}
      >
        <Trash2 aria-hidden="true" />
      </ThreadActionButton>
    </div>
  </div>
);

type ThreadActionButtonProps = Readonly<{
  label: string;
  active: boolean;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}>;

const ThreadActionButton = ({
  label,
  active,
  disabled,
  destructive = false,
  onClick,
  children,
}: ThreadActionButtonProps) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className={`rounded p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
      destructive
        ? 'text-tertiary hover:bg-destructive/10 hover:text-destructive'
        : 'text-tertiary hover:bg-surface hover:text-foreground'
    }`}
  >
    {active ? (
      <LoaderCircle
        className="size-3.5 animate-spin"
        aria-hidden="true"
      />
    ) : (
      <span className="[&>svg]:size-3.5">{children}</span>
    )}
  </button>
);
