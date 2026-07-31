import {
  Archive,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  GitFork,
  LoaderCircle,
  Plus,
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
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { useStore as useWorkspaceNavigationStore } from '@/renderer/components/workspace/navigation/use-store';

import appIcon from '../../../../assets/icon.png';

import type { ThreadStore } from './types';

type ThreadNavigatorProps = Readonly<{
  store: ThreadStore;
  id?: string;
  footer?: ReactNode;
}>;

type ThreadLabelKind = 'project' | 'chat';

const focusThreadAt = (
  container: HTMLElement,
  index: number,
): void => {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-thread-button]'),
  );
  buttons.at(index)?.focus();
};

export const ThreadNavigator = ({
  store,
  id,
  footer,
}: ThreadNavigatorProps) => {
  const [query, setQuery] = useState<string>(store.navigator.query);
  const [projectExpanded, setProjectExpanded] = useState<boolean>(true);
  const [deleteThreadId, setDeleteThreadId] = useState<string | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const workspace = useWorkspaceNavigationStore();
  const searchDisabled =
    store.navigator.status === 'unavailable' ||
    store.navigator.status === 'loading' ||
    Boolean(store.navigator.pendingMutation);
  const selectionDisabled =
    searchDisabled ||
    store.navigator.searchStatus === 'loading' ||
    store.thread.phase === 'starting' ||
    store.thread.phase === 'inProgress' ||
    store.thread.phase === 'stopping' ||
    workspace.busy;
  const projectActive =
    workspace.state.status === 'ready' &&
    workspace.state.kind === 'project';
  const chatActive =
    workspace.state.status === 'ready' &&
    workspace.state.kind === 'chat';
  const projectName =
    workspace.state.projectName ??
    (projectActive ? workspace.state.name : undefined);
  const projectThreadIds = projectActive
    ? store.navigator.threadIds
    : workspace.state.projectThreadIds ?? [];
  const chatThreadIds = chatActive
    ? store.navigator.threadIds
    : workspace.state.chatThreadIds ?? [];
  const activeLabelKind: ThreadLabelKind = chatActive ? 'chat' : 'project';
  const currentOutsideResults =
    store.navigator.selectedThreadId &&
    !store.navigator.threadIds.includes(store.navigator.selectedThreadId);

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

  const startProjectTask = async (): Promise<void> => {
    const activated = projectActive
      ? true
      : projectName
        ? await workspace.resumeProject()
        : await workspace.chooseProject();
    if (activated) {
      await store.startNewThread();
    }
  };

  const startChat = async (): Promise<void> => {
    if (await workspace.activateChat()) {
      await store.startNewThread();
    }
  };

  const selectProjectThread = async (threadId: string): Promise<void> => {
    if (!projectActive && !(await workspace.resumeProject())) {
      return;
    }
    await store.selectThread(threadId);
  };

  const selectChatThread = async (threadId: string): Promise<void> => {
    await workspace.activateChat(threadId);
  };

  const renderThreadList = (
    threadIds: readonly string[],
    kind: ThreadLabelKind,
    active: boolean,
    onSelect: (threadId: string) => Promise<void>,
  ): ReactNode => (
    <div className="space-y-0.5 pb-1 pl-5 pt-0.5">
      {active && currentOutsideResults ? (
        <>
          <p className="px-2 pb-1 pt-2 text-[11px] text-tertiary">
            当前{kind === 'chat' ? '聊天' : '任务'}
          </p>
          <ThreadButton
            threadId={store.navigator.selectedThreadId as string}
            current
            pending={false}
            disabled={selectionDisabled}
            labelKind={kind}
            actionsEnabled
            onSelect={onSelect}
            onFork={store.forkThread}
            onArchive={store.archiveThread}
            onRequestDelete={setDeleteThreadId}
            pendingMutation={store.navigator.pendingMutation}
          />
        </>
      ) : null}
      {threadIds.map((threadId) => (
        <ThreadButton
          key={threadId}
          threadId={threadId}
          current={
            active &&
            threadId === store.navigator.selectedThreadId
          }
          pending={
            active &&
            threadId === store.navigator.pendingThreadId
          }
          disabled={selectionDisabled}
          labelKind={kind}
          actionsEnabled={active}
          onSelect={onSelect}
          onFork={store.forkThread}
          onArchive={store.archiveThread}
          onRequestDelete={setDeleteThreadId}
          pendingMutation={store.navigator.pendingMutation}
        />
      ))}
      {threadIds.length === 0 &&
      (!active || store.navigator.searchStatus !== 'loading') ? (
        <p className="px-2 py-2 text-xs leading-5 text-secondary">
          {active && store.navigator.searchStatus === 'empty'
            ? `没有匹配的${kind === 'chat' ? '聊天' : '任务'}。`
            : kind === 'chat'
              ? '点击栏目右侧的 + 新建聊天。'
              : '点击项目右侧的 + 新建任务。'}
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      <nav
        id={id}
        aria-label="Threads"
        className="flex h-full min-h-0 w-full flex-col bg-surface/55"
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
        <div className="shrink-0 px-3 pb-2 pt-3">
          <div className="mb-3 flex h-8 items-center gap-2 px-1">
            <img
              src={appIcon}
              alt=""
              className="size-6 shrink-0"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.02em]">
              SugarCode
            </p>
          </div>
          <form className="flex gap-1.5" onSubmit={submit}>
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
                placeholder={`搜索${activeLabelKind === 'chat' ? '聊天' : '任务'}`}
                className="h-8 border-transparent bg-surface-hover pl-8 pr-8 shadow-none focus-visible:border-border"
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
              size="icon-sm"
              variant="ghost"
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
          className="sr-only"
          role={
            store.navigator.searchStatus === 'error'
              ? 'alert'
              : 'status'
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
            className="space-y-3 p-2"
            onKeyDown={handleListKeyDown}
          >
            <section aria-labelledby="project-section-title">
              <SectionHeading
                id="project-section-title"
                label="项目"
                count={projectThreadIds.length}
                actionLabel="打开项目"
                disabled={workspace.busy}
                onAction={() => void workspace.chooseProject()}
              >
                {workspace.busy ? (
                  <LoaderCircle
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <FolderPlus aria-hidden="true" />
                )}
              </SectionHeading>

              {projectName ? (
                <>
                  <div
                    className={`group flex items-center rounded-lg ${
                      projectActive
                        ? 'bg-surface-hover/70'
                        : 'hover:bg-surface-hover'
                    }`}
                  >
                    <button
                      type="button"
                      className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={projectExpanded}
                      onClick={() => {
                        if (!projectActive) {
                          void workspace.resumeProject();
                        } else {
                          setProjectExpanded((current) => !current);
                        }
                      }}
                    >
                      <ChevronDown
                        className={`size-3.5 shrink-0 text-tertiary transition-transform ${
                          projectExpanded ? '' : '-rotate-90'
                        }`}
                        aria-hidden="true"
                      />
                      <Folder
                        className="size-4 shrink-0 text-secondary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {projectName}
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="mr-1 opacity-60 group-hover:opacity-100"
                      disabled={selectionDisabled}
                      onClick={() => void startProjectTask()}
                      aria-label={`在 ${projectName} 中新建任务`}
                      title={`在 ${projectName} 中新建任务`}
                    >
                      <Plus aria-hidden="true" />
                    </Button>
                  </div>
                  {projectExpanded
                    ? renderThreadList(
                        projectThreadIds,
                        'project',
                        projectActive,
                        selectProjectThread,
                      )
                    : null}
                </>
              ) : (
                <button
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-secondary transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  disabled={workspace.busy}
                  onClick={() => void workspace.chooseProject()}
                >
                  <span className="w-3.5 shrink-0" aria-hidden="true" />
                  <FolderOpen
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-sm">打开项目</span>
                </button>
              )}
            </section>

            <section aria-labelledby="chat-section-title">
              <SectionHeading
                id="chat-section-title"
                label="聊天"
                count={chatThreadIds.length}
                actionLabel="新建聊天"
                disabled={selectionDisabled}
                onAction={() => void startChat()}
              >
                <Plus aria-hidden="true" />
              </SectionHeading>
              {renderThreadList(
                chatThreadIds,
                'chat',
                chatActive,
                selectChatThread,
              )}
            </section>

            {workspace.error ? (
              <p
                className="mx-2 text-xs leading-5 text-destructive"
                role="alert"
              >
                {workspace.error}
              </p>
            ) : null}
          </div>
        </ScrollArea>

        {store.navigator.selectionNotice ? (
          <p
            className="border-t px-4 py-3 text-xs text-destructive"
            role="alert"
          >
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
              对话已归档，可在下一次生命周期操作或重连前撤销。
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
              撤销
            </Button>
          </div>
        ) : null}
        {footer ? (
          <div className="shrink-0 border-t p-2">{footer}</div>
        ) : null}
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
            <AlertDialogTitle>永久删除这个对话？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复。如需暂时隐藏，请改用归档。
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
                取消
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
                永久删除
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

type SectionHeadingProps = Readonly<{
  id: string;
  label: string;
  count: number;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
  children: ReactNode;
}>;

const SectionHeading = ({
  id,
  label,
  count,
  actionLabel,
  disabled,
  onAction,
  children,
}: SectionHeadingProps) => (
  <div className="mb-1 flex h-7 items-center px-2 text-sm text-secondary">
    <span id={id}>{label}</span>
    <span className="ml-auto text-xs tabular-nums text-tertiary">
      {count}
    </span>
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="ml-1"
      disabled={disabled}
      onClick={onAction}
      aria-label={actionLabel}
      title={actionLabel}
    >
      {children}
    </Button>
  </div>
);

type ThreadButtonProps = Readonly<{
  threadId: string;
  current: boolean;
  pending: boolean;
  disabled: boolean;
  labelKind: ThreadLabelKind;
  actionsEnabled: boolean;
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
  labelKind,
  actionsEnabled,
  pendingMutation,
  onSelect,
  onFork,
  onArchive,
  onRequestDelete,
}: ThreadButtonProps) => (
  <div
    className={`group/session flex min-w-0 items-stretch rounded-lg transition-colors ${
      current
        ? 'bg-surface-hover text-foreground'
        : 'text-secondary hover:bg-surface-hover hover:text-foreground'
    }`}
  >
    <button
      type="button"
      data-thread-button
      aria-current={current ? 'page' : undefined}
      aria-label={`${current ? 'Current ' : ''}Thread ${threadId}`}
      disabled={disabled}
      onClick={() => void onSelect(threadId)}
      className={`flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
        actionsEnabled ? 'rounded-l-lg' : 'rounded-lg'
      }`}
    >
      {pending ? (
        <LoaderCircle
          className="mt-0.5 size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : (
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            current ? 'bg-primary' : 'bg-tertiary'
          }`}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-normal">
        {current
          ? labelKind === 'chat'
            ? '当前聊天'
            : '当前任务'
          : `${labelKind === 'chat' ? '聊天' : '任务'} ${threadId.slice(-4)}`}
      </span>
    </button>
    {actionsEnabled ? (
      <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100">
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
    ) : null}
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
