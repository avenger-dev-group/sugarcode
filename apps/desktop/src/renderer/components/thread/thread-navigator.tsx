import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Folder,
  FolderOpen,
  FolderPlus,
  GitFork,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  RotateCcw,
  ShieldQuestion,
  Trash2,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
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
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { useStore as useWorkspaceNavigationStore } from '@/renderer/components/workspace/navigation/use-store';

import appIcon from '../../../../assets/icon.png';

import { toThreadNavigationStatus } from './navigation-status';
import type { ThreadNavigationStatus, ThreadStore } from './types';

type ThreadNavigatorProps = Readonly<{
  store: ThreadStore;
  footer?: ReactNode;
  onToggleNavigator?: () => void;
  approvalThreadIds?: readonly string[];
}>;

type ThreadLabelKind = 'project' | 'chat';

type DeleteRequest = Readonly<{
  threadId: string;
  source: 'conversation' | 'failedChat';
}>;

const focusThreadAt = (
  container: HTMLElement,
  index: number,
): void => {
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[data-thread-item]'),
  );
  items.at(index)?.focus();
};

const activateNavigationItem = (
  event: KeyboardEvent<HTMLElement>,
  disabled: boolean,
  activate: () => void,
): void => {
  if (disabled || (event.key !== 'Enter' && event.key !== ' ')) {
    return;
  }
  event.preventDefault();
  activate();
};

export const ThreadNavigator = ({
  store,
  footer,
  onToggleNavigator,
  approvalThreadIds = [],
}: ThreadNavigatorProps) => {
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(
    null,
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const workspace = useWorkspaceNavigationStore();
  const navigationDisabled =
    store.navigator.status === 'unavailable' ||
    store.navigator.status === 'loading' ||
    Boolean(store.navigator.pendingMutation);
  const selectedTurnActive =
    store.thread.phase === 'starting' ||
    store.thread.phase === 'inProgress' ||
    store.thread.phase === 'stopping';
  const projectActive =
    workspace.state.status === 'ready' &&
    workspace.state.kind === 'project';
  const chatActive =
    workspace.state.status === 'ready' &&
    workspace.state.kind === 'chat';
  const projectName =
    workspace.state.projectName ??
    (projectActive ? workspace.state.name : undefined);
  const projectThreadIds =
    workspace.state.projectThreadIds ??
    (projectActive ? store.navigator.threadIds : []);
  const chatThreadIds =
    workspace.state.chatThreadIds ??
    (chatActive ? store.navigator.threadIds : []);
  const projects =
    workspace.state.projects && workspace.state.projects.length > 0
      ? workspace.state.projects
      : projectName
        ? [
            {
              id: workspace.state.activeProjectId ?? 'legacy-project',
              name: projectName,
              threadIds: projectThreadIds,
              threadTitles: store.navigator.threadTitles,
              lastOpenedAtMs: 0,
            },
          ]
        : [];

  const handleListKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
  ): void => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[data-thread-item]',
      ),
    );
    const current = items.indexOf(
      document.activeElement as HTMLElement,
    );
    if (items.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusThreadAt(event.currentTarget, (current + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusThreadAt(
        event.currentTarget,
        (current - 1 + items.length) % items.length,
      );
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusThreadAt(event.currentTarget, 0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusThreadAt(event.currentTarget, -1);
    }
  };

  const startProjectTask = async (projectId?: string): Promise<void> => {
    const activated =
      projectActive &&
      (!projectId || workspace.state.activeProjectId === projectId)
      ? true
      : projectId
        ? await workspace.activateProject(projectId)
        : projectName
          ? await workspace.resumeProject()
        : await workspace.chooseProject();
    if (activated) {
      if (
        projectId &&
        !store.expandedProjectIds.includes(projectId)
      ) {
        store.toggleProjectExpanded(projectId);
      }
      await store.startNewThread();
    }
  };

  const activateChat = async (threadId?: string): Promise<boolean> => {
    return threadId
      ? await workspace.activateChat(threadId)
      : await workspace.activateChat();
  };

  const startChat = async (): Promise<void> => {
    if (await activateChat()) {
      await store.startNewThread();
    }
  };

  const selectProjectThread = async (
    projectId: string,
    threadId: string,
  ): Promise<void> => {
    if (
      (!projectActive || workspace.state.activeProjectId !== projectId) &&
      !(await workspace.activateProject(projectId))
    ) {
      return;
    }
    await store.selectThread(threadId);
  };

  const selectChatThread = async (threadId: string): Promise<void> => {
    await activateChat(threadId);
  };

  const renderThreadList = (
    threadIds: readonly string[],
    threadTitles: Readonly<Record<string, string>>,
    kind: ThreadLabelKind,
    active: boolean,
    onSelect: (threadId: string) => Promise<void>,
  ): ReactNode => {
    const displayedThreadId = active
      ? store.navigator.pendingThreadId ??
        store.navigator.selectedThreadId
      : null;
    const itemDisabled = workspace.busy || (active && navigationDisabled);
    return (
      <div className="space-y-0.5 pb-1 pl-6 pt-1">
        {threadIds.map((threadId) => (
          <ThreadButton
            key={threadId}
            threadId={threadId}
            title={
              (active ? store.navigator.threadTitles[threadId] : undefined) ??
              threadTitles[threadId] ??
              workspace.state.chatTitles?.[threadId]
            }
            current={threadId === displayedThreadId}
            status={toThreadNavigationStatus({
              approvalRequired: approvalThreadIds.includes(threadId),
              pending:
                active && threadId === store.navigator.pendingThreadId,
              reloadRequired:
                store.navigator.reloadRequiredThreadIds.includes(threadId),
              running: store.navigator.runningThreadIds.includes(threadId),
              terminalStatus:
                store.navigator.unreadThreadStatuses[threadId],
            })}
            disabled={itemDisabled}
            mutationDisabled={
              navigationDisabled ||
              workspace.busy ||
              (threadId === displayedThreadId && selectedTurnActive)
            }
            actionsEnabled={active}
            failedDeleteEnabled={
              kind === 'chat' &&
              workspace.failedChatThreadId === threadId
            }
            failedDeleteDisabled={workspace.busy}
            onSelect={onSelect}
            onFork={store.forkThread}
            onArchive={store.archiveThread}
            onRequestDelete={(requestedThreadId) =>
              setDeleteRequest({
                threadId: requestedThreadId,
                source:
                  kind === 'chat' &&
                  workspace.failedChatThreadId === requestedThreadId
                    ? 'failedChat'
                    : 'conversation',
              })
            }
            pendingMutation={store.navigator.pendingMutation}
          />
        ))}
        {threadIds.length === 0 ? (
          kind === 'project' ? (
            <p className="px-2 py-1.5 text-sm font-normal leading-normal text-tertiary">
              没有会话
            </p>
          ) : (
            <p className="px-2 py-2 text-xs leading-5 text-secondary">
              点击栏目右侧的 + 新建聊天。
            </p>
          )
        ) : null}
      </div>
    );
  };

  return (
    <>
      <nav
        aria-label="Threads"
        className="flex h-full min-h-0 w-full flex-col bg-navigation-background"
      >
        <div className="window-drag-region relative shrink-0 px-3 pb-2 pt-10">
          {onToggleNavigator ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="window-no-drag absolute left-[84px] top-1.5 text-tertiary"
              onClick={onToggleNavigator}
              aria-controls="task-navigator"
              aria-expanded="true"
              aria-label="关闭左侧任务栏"
              title="关闭左侧任务栏"
            >
              <PanelLeftClose aria-hidden="true" />
            </Button>
          ) : null}
          <div className="flex h-8 items-center gap-2 px-1">
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
        </div>

        <p
          className="sr-only"
          role={store.navigator.status === 'error' ? 'alert' : 'status'}
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
                count={projects.length}
                actionLabel="打开项目"
                disabled={workspace.busy}
                onAction={() => void workspace.chooseProject()}
              >
                <FolderPlus aria-hidden="true" />
              </SectionHeading>

              {projects.length > 0 ? (
                <div className="space-y-1">
                  {projects.map((project) => {
                    const active =
                      projectActive &&
                      workspace.state.activeProjectId === project.id;
                    const expanded = store.expandedProjectIds.includes(
                      project.id,
                    );
                    return (
                      <div key={project.id}>
                        <div
                          data-project-row
                          className="group flex items-center rounded-lg"
                        >
                          <span
                            role="button"
                            tabIndex={workspace.busy ? -1 : 0}
                            data-thread-item
                            aria-expanded={expanded}
                            aria-disabled={workspace.busy}
                            className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-navigation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default"
                            onClick={() => {
                              if (!workspace.busy) {
                                store.toggleProjectExpanded(project.id);
                              }
                            }}
                            onKeyDown={(event) =>
                              activateNavigationItem(
                                event,
                                workspace.busy,
                                () => {
                                  store.toggleProjectExpanded(project.id);
                                },
                              )
                            }
                          >
                            {expanded ? (
                              <FolderOpen
                                className="size-4 shrink-0 text-navigation"
                                aria-hidden="true"
                              />
                            ) : (
                              <Folder
                                className="size-4 shrink-0 text-navigation"
                                aria-hidden="true"
                              />
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm font-normal">
                              {project.name}
                            </span>
                          </span>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="mr-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-0 group-hover:disabled:opacity-100 group-focus-within:disabled:opacity-100"
                            disabled={
                              workspace.busy || (active && navigationDisabled)
                            }
                            onClick={() => void startProjectTask(project.id)}
                            aria-label={`在 ${project.name} 中新建任务`}
                            title={`在 ${project.name} 中新建任务`}
                          >
                            <Plus aria-hidden="true" />
                          </Button>
                        </div>
                        {expanded
                          ? renderThreadList(
                              project.threadIds,
                              project.threadTitles,
                              'project',
                              active,
                              (threadId) =>
                                selectProjectThread(project.id, threadId),
                            )
                          : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-secondary transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                disabled={workspace.busy || (chatActive && navigationDisabled)}
                onAction={() => void startChat()}
              >
                <Plus aria-hidden="true" />
              </SectionHeading>
              {renderThreadList(
                chatThreadIds,
                workspace.state.chatTitles ?? {},
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
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteRequest(null);
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
            <AlertDialogTitle>删除这个对话？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复，确定要继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
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
                  if (deleteRequest?.source === 'failedChat') {
                    void workspace.deleteFailedChat(deleteRequest.threadId);
                  } else if (deleteRequest) {
                    void store.deleteThread(deleteRequest.threadId);
                  }
                }}
              >
                删除
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
  <div className="mb-1 flex h-7 items-center px-2 text-sm font-normal">
    <span id={id} className="text-navigation-heading">
      {label}
    </span>
    <span className="ml-auto text-xs tabular-nums text-tertiary">
      {count}
    </span>
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="ml-1 disabled:opacity-100"
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
  title?: string;
  current: boolean;
  status: ThreadNavigationStatus;
  disabled: boolean;
  mutationDisabled: boolean;
  actionsEnabled: boolean;
  failedDeleteEnabled: boolean;
  failedDeleteDisabled: boolean;
  pendingMutation: ThreadStore['navigator']['pendingMutation'];
  onSelect: (threadId: string) => Promise<void>;
  onFork: (threadId: string) => Promise<void>;
  onArchive: (threadId: string) => Promise<void>;
  onRequestDelete: (threadId: string) => void;
}>;

const ThreadButton = ({
  threadId,
  title,
  current,
  status,
  disabled,
  mutationDisabled,
  actionsEnabled,
  failedDeleteEnabled,
  failedDeleteDisabled,
  pendingMutation,
  onSelect,
  onFork,
  onArchive,
  onRequestDelete,
}: ThreadButtonProps) => (
  <div
    data-thread-row
    className={`group/session grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-stretch overflow-hidden rounded-lg ${
      current
        ? 'bg-surface text-foreground'
        : 'text-navigation hover:bg-surface hover:text-foreground'
    }`}
  >
    <span
      role="link"
      tabIndex={disabled ? -1 : 0}
      data-thread-item
      aria-current={current ? 'page' : undefined}
      aria-busy={status === 'opening' || status === 'running'}
      aria-label={`${current ? 'Current ' : ''}${title ?? 'Untitled conversation'}`}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) {
          void onSelect(threadId);
        }
      }}
      onKeyDown={(event) =>
        activateNavigationItem(event, disabled, () => {
          void onSelect(threadId);
        })
      }
      className={`flex h-9 min-w-0 flex-1 cursor-pointer items-center px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default ${
        actionsEnabled || failedDeleteEnabled ? 'rounded-l-lg' : 'rounded-lg'
      }`}
    >
      <span
        className={`min-w-0 flex-1 truncate text-sm ${current ? 'font-medium' : 'font-normal'}`}
      >
        {title ?? (status === 'running' ? '新会话' : '未命名会话')}
      </span>
    </span>
    {actionsEnabled || failedDeleteEnabled ? (
      <div
        data-thread-actions
        className={`flex min-w-fit shrink-0 items-center pr-1 transition-opacity ${
          failedDeleteEnabled
            ? 'opacity-100'
            : 'opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100'
        }`}
      >
        {actionsEnabled ? (
          <>
            <ThreadActionButton
              label={`创建会话分支：${title ?? '未命名会话'}`}
              active={
                pendingMutation?.kind === 'fork' &&
                pendingMutation.threadId === threadId
              }
              disabled={mutationDisabled}
              onClick={() => void onFork(threadId)}
            >
              <GitFork aria-hidden="true" />
            </ThreadActionButton>
            <ThreadActionButton
              label={`归档会话：${title ?? '未命名会话'}`}
              active={
                pendingMutation?.kind === 'archive' &&
                pendingMutation.threadId === threadId
              }
              disabled={mutationDisabled}
              onClick={() => void onArchive(threadId)}
            >
              <Archive aria-hidden="true" />
            </ThreadActionButton>
          </>
        ) : null}
        <ThreadActionButton
          label={`删除会话：${title ?? '未命名会话'}`}
          active={
            pendingMutation?.kind === 'delete' &&
            pendingMutation.threadId === threadId
          }
          disabled={
            failedDeleteEnabled ? failedDeleteDisabled : mutationDisabled
          }
          destructive
          onClick={() => onRequestDelete(threadId)}
        >
          <Trash2 aria-hidden="true" />
        </ThreadActionButton>
      </div>
    ) : (
      <span />
    )}
    <ThreadStatusIndicator status={status} />
  </div>
);

const ThreadStatusIndicator = ({
  status,
}: Readonly<{ status: ThreadNavigationStatus }>) => {
  switch (status) {
    case 'approvalRequired':
      return (
        <span
          className="mr-2 inline-flex h-5 shrink-0 self-center items-center gap-1 rounded-full border bg-background px-1.5 text-[11px] font-medium text-secondary"
          role="status"
          title="需要授权"
        >
          <ShieldQuestion className="size-3" aria-hidden="true" />
          需授权
        </span>
      );
    case 'opening':
    case 'running': {
      const label = status === 'opening' ? '正在打开会话' : '后台运行中';
      return (
        <span
          className="mr-2 inline-flex size-5 shrink-0 self-center items-center justify-center text-process"
          role="status"
          aria-label={label}
          title={label}
        >
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        </span>
      );
    }
    case 'completed':
      return (
        <span
          className="mr-2 inline-flex size-5 shrink-0 self-center items-center justify-center text-success"
          role="status"
          aria-label="后台任务已完成，有未读更新"
          title="已完成 · 有未读更新"
        >
          <CircleCheck className="size-4" aria-hidden="true" />
        </span>
      );
    case 'failed':
      return (
        <span
          className="mr-2 inline-flex size-5 shrink-0 self-center items-center justify-center text-destructive"
          role="status"
          aria-label="后台任务执行失败，有未读更新"
          title="执行失败 · 有未读更新"
        >
          <CircleAlert className="size-4" aria-hidden="true" />
        </span>
      );
    case 'reloadRequired':
      return (
        <span
          className="mr-2 inline-flex size-5 shrink-0 self-center items-center justify-center text-destructive"
          role="status"
          aria-label="会话需要重新加载"
          title="会话需要重新加载"
        >
          <CircleAlert className="size-4" aria-hidden="true" />
        </span>
      );
    case 'interrupted':
      return (
        <span
          className="mr-2 inline-flex size-5 shrink-0 self-center items-center justify-center text-tertiary"
          role="status"
          aria-label="后台任务已停止，有未读更新"
          title="已停止 · 有未读更新"
        >
          <CircleStop className="size-4" aria-hidden="true" />
        </span>
      );
    case 'idle':
      return null;
  }
};

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
