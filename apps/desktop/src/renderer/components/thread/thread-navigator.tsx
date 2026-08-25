import {
  Blocks,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleStop,
  Folder,
  FolderOpen,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  Search,
  LibraryBig,
  ShieldQuestion,
  Trash2,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/renderer/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/renderer/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { useStore as useWorkspaceNavigationStore } from '@/renderer/components/workspace/navigation/use-store';

import appIcon from '../../../../assets/icon.png';

import {
  isThreadDeleteDisabled,
  resolveDisplayedThreadId,
  toThreadNavigationStatus,
} from './navigation-status';
import type { ThreadNavigationStatus, ThreadStore } from './types';
import type { AppSurface } from '../foundation/types';

type ThreadNavigatorProps = Readonly<{
  store: ThreadStore;
  footer?: ReactNode;
  onToggleNavigator?: () => void;
  approvalThreadIds?: readonly string[];
  surface?: AppSurface;
  onOpenSearch?: () => void;
  onOpenKnowledge?: () => void;
  onOpenSkills?: () => void;
  onOpenWorkbench?: () => void;
}>;

type DeleteRequest =
  | Readonly<{
      kind: 'project';
      projectId: string;
      name: string;
    }>
  | Readonly<{
      kind: 'thread';
      threadId: string;
      title: string;
      workspaceKind: 'project' | 'chat';
    }>;

const EAGER_PROJECT_THREAD_COUNT = 8;
const DEFERRED_PROJECT_THREAD_DELAY_MS = 180;

type DeferredThreadListProps = Readonly<{
  open: boolean;
  threadCount: number;
  render: (renderedThreadCount: number) => ReactNode;
}>;

const DeferredThreadList = ({
  open,
  threadCount,
  render,
}: DeferredThreadListProps): ReactNode => {
  const [fullyRendered, setFullyRendered] = useState<boolean>(false);

  useEffect(() => {
    if (!open || threadCount <= EAGER_PROJECT_THREAD_COUNT) {
      return;
    }
    const timer = window.setTimeout(
      () => setFullyRendered(true),
      DEFERRED_PROJECT_THREAD_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [open, threadCount]);

  return render(
    fullyRendered
      ? threadCount
      : Math.min(threadCount, EAGER_PROJECT_THREAD_COUNT),
  );
};

const focusThreadAt = (
  container: HTMLElement,
  index: number,
): void => {
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[data-thread-item]'),
  );
  items.at(index)?.focus();
};

export const ThreadNavigator = ({
  store,
  footer,
  onToggleNavigator,
  approvalThreadIds = [],
  surface = 'workbench',
  onOpenSearch,
  onOpenKnowledge,
  onOpenSkills,
  onOpenWorkbench,
}: ThreadNavigatorProps) => {
  const searchShortcut = navigator.platform.toLocaleLowerCase().includes('mac')
    ? '⌘K'
    : 'Ctrl K';
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(
    null,
  );
  const [deletePending, setDeletePending] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const projectLayoutRef = useRef<ReadonlyMap<string, number> | null>(
    null,
  );
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const workspace = useWorkspaceNavigationStore();
  const navigationDisabled =
    store.navigator.status === 'unavailable' ||
    store.navigator.status === 'loading' ||
    Boolean(store.navigator.pendingMutation);
  const projectActive =
    workspace.state.status === 'ready' &&
    workspace.state.kind === 'project';
  const chatActive =
    workspace.state.status === 'ready' &&
    workspace.state.kind === 'chat';
  const projectName =
    workspace.state.projectName ??
    (workspace.state.projects === undefined && projectActive
      ? workspace.state.name
      : undefined);
  const projectThreadIds =
    workspace.state.projectThreadIds ??
    (projectActive ? store.navigator.threadIds : []);
  const chatThreadIds =
    workspace.state.chatThreadIds ??
    (chatActive ? store.navigator.threadIds : []);
  const projects =
    workspace.state.projects !== undefined
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

  const captureProjectLayout = (): void => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const positions = new Map<string, number>();
    list
      .querySelectorAll<HTMLElement>('[data-project-layout-item]')
      .forEach((item) => {
        const key = item.dataset.projectLayoutItem;
        if (!key) {
          return;
        }
        positions.set(key, item.getBoundingClientRect().top);
        item.getAnimations().forEach((animation) => animation.cancel());
      });
    projectLayoutRef.current = positions;
  };

  useLayoutEffect(() => {
    const previousPositions = projectLayoutRef.current;
    const list = listRef.current;
    projectLayoutRef.current = null;
    if (
      !previousPositions ||
      !list ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    list
      .querySelectorAll<HTMLElement>('[data-project-layout-item]')
      .forEach((item) => {
        const key = item.dataset.projectLayoutItem;
        const previousTop = key ? previousPositions.get(key) : undefined;
        if (previousTop === undefined) {
          return;
        }
        const deltaY = previousTop - item.getBoundingClientRect().top;
        if (Math.abs(deltaY) < 0.5) {
          return;
        }
        const animation = item.animate(
          [
            { transform: `translate3d(0, ${deltaY}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          {
            duration: 160,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            fill: 'both',
          },
        );
        animation.addEventListener('finish', () => animation.cancel(), {
          once: true,
        });
      });
  }, [store.expandedProjectIds]);

  const startProjectTask = async (projectId?: string): Promise<void> => {
    onOpenWorkbench?.();
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
    onOpenWorkbench?.();
    if (await activateChat()) {
      await store.startNewThread();
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const request = deleteRequest;
    if (!request || deletePending) {
      return;
    }
    setDeletePending(true);
    setDeleteError(null);
    const deleted =
      request.kind === 'project'
        ? await workspace.removeProject(request.projectId)
        : await workspace.deleteTask(request.threadId);
    if (deleted) {
      setDeleteRequest(null);
    } else {
      setDeleteError(
        request.kind === 'project'
          ? '无法从列表移除这个项目，请稍后重试。'
          : request.workspaceKind === 'chat'
            ? '无法删除这个对话或清理对应的本地文件夹，请确认任务已经停止后重试。'
            : '无法删除这个对话，请确认任务已经停止后重试。',
      );
    }
    setDeletePending(false);
  };

  const selectProjectThread = async (
    _projectId: string,
    threadId: string,
  ): Promise<void> => {
    const focus = workspace.focusTask(threadId);
    onOpenWorkbench?.();
    await focus;
  };

  const selectChatThread = async (threadId: string): Promise<void> => {
    const focus = workspace.focusTask(threadId);
    onOpenWorkbench?.();
    await focus;
  };

  const renderThreadList = (
    threadIds: readonly string[],
    threadTitles: Readonly<Record<string, string>>,
    active: boolean,
    onSelect: (threadId: string) => Promise<void>,
    workspaceKind: 'project' | 'chat',
    nested = false,
    renderedThreadCount = threadIds.length,
  ): ReactNode => {
    const visibleThreadIds = threadIds.slice(0, renderedThreadCount);
    const deferredThreadCount = threadIds.length - visibleThreadIds.length;
    const displayedThreadId = resolveDisplayedThreadId({
      active,
      pendingThreadId: store.navigator.pendingThreadId,
      selectedThreadId: store.navigator.selectedThreadId,
      threadIds,
    });
    const itemDisabled = workspace.busy || (active && navigationDisabled);
    return (
      <div
        aria-busy={deferredThreadCount > 0}
        className={`space-y-0.5 py-1 ${
          nested
            ? 'ml-3 border-l border-border-subtle pl-2'
            : ''
        }`}
      >
        {visibleThreadIds.map((threadId) => (
          <ThreadButton
            key={threadId}
            threadId={threadId}
            title={
              (active ? store.navigator.threadTitles[threadId] : undefined) ??
              threadTitles[threadId] ??
              workspace.state.chatTitles?.[threadId]
            }
            current={surface === 'workbench' && threadId === displayedThreadId}
            status={toThreadNavigationStatus({
              inputRequired:
                store.navigator.inputRequiredThreadIds.includes(threadId),
              approvalRequired: approvalThreadIds.includes(threadId),
              pending: threadId === store.navigator.pendingThreadId,
              running: store.navigator.runningThreadIds.includes(threadId),
              terminalStatus:
                store.navigator.unreadThreadStatuses[threadId],
            })}
            disabled={itemDisabled}
            renameDisabled={workspace.busy}
            deleteDisabled={
              isThreadDeleteDisabled({
                workspaceBusy: workspace.busy,
                lifecycleMutationPending: Boolean(
                  store.navigator.pendingMutation,
                ),
                running:
                  store.navigator.runningThreadIds.includes(threadId),
              })
            }
            onSelect={onSelect}
            onRequestRename={(requestedThreadId) => {
              const currentTitle =
                (active
                  ? store.navigator.threadTitles[requestedThreadId]
                  : undefined) ??
                threadTitles[requestedThreadId] ??
                workspace.state.chatTitles?.[requestedThreadId] ??
                '新对话';
              store.requestThreadRename(requestedThreadId, currentTitle);
            }}
            onRequestDelete={(requestedThreadId) => {
              setDeleteError(null);
              setDeleteRequest({
                kind: 'thread',
                threadId: requestedThreadId,
                title:
                  threadTitles[requestedThreadId] ??
                  workspace.state.chatTitles?.[requestedThreadId] ??
                  '新对话',
                workspaceKind,
              });
            }}
            pendingMutation={store.navigator.pendingMutation}
          />
        ))}
        {deferredThreadCount > 0 ? (
          <div
            className="pointer-events-none"
            style={{
              height: `calc(${deferredThreadCount} * 2.375rem - 0.125rem)`,
            }}
            aria-hidden="true"
          />
        ) : null}
        {threadIds.length === 0 ? (
          <p className="px-2 py-1 text-sm font-normal leading-normal text-tertiary">
            {nested ? '还没有任务' : '还没有聊天'}
          </p>
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
        <div className="window-drag-region relative shrink-0 px-3 pb-3 pt-10">
          {onToggleNavigator ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="window-leading-toggle window-no-drag absolute top-1.5 text-tertiary"
              onClick={onToggleNavigator}
              aria-controls="task-navigator"
              aria-expanded="true"
              aria-label="关闭左侧任务栏"
              title="关闭左侧任务栏"
            >
              <PanelLeftClose aria-hidden="true" />
            </Button>
          ) : null}
          <div className="flex h-10 items-center gap-2.5 px-1">
            <img
              src={appIcon}
              alt=""
              className="size-9 shrink-0 rounded-xl shadow-sm"
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
          {store.navigator.mutationNotice
            ? ` · ${store.navigator.mutationNotice}`
            : ''}
        </p>

        <div className="px-2 pb-2">
          <button
            type="button"
            className="window-no-drag flex h-9 w-full items-center gap-2 rounded-lg border border-border/80 bg-background/80 px-2.5 text-left text-sm text-tertiary shadow-sm transition-colors hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpenSearch}
          >
            <Search className="size-4" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">搜索或运行…</span>
            <kbd className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-tertiary">{searchShortcut}</kbd>
          </button>
          <div className="mt-1.5 space-y-0.5">
            <NavigatorSurfaceButton
              active={surface === 'knowledge'}
              icon={LibraryBig}
              label="本地知识库"
              onClick={onOpenKnowledge}
            />
            <NavigatorSurfaceButton
              active={surface === 'capabilities'}
              icon={Blocks}
              label="能力中心"
              onClick={onOpenSkills}
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div
            ref={listRef}
            className="space-y-5 p-2"
            onKeyDown={handleListKeyDown}
          >
            <section aria-labelledby="project-section-title">
              <SectionHeading
                id="project-section-title"
                label="项目"
                actionLabel="选择项目文件夹"
                disabled={workspace.busy}
                onAction={() => void workspace.chooseProject()}
              />

              {projects.length > 0 ? (
                <div className="space-y-1.5">
                  {projects.map((project) => {
                    const active =
                      projectActive &&
                      workspace.state.activeProjectId === project.id;
                    const expanded = store.expandedProjectIds.includes(
                      project.id,
                    );
                    return (
                      <Collapsible
                        key={project.id}
                        data-project-layout-item={project.id}
                        className="relative"
                        open={expanded}
                        onOpenChange={(open) => {
                          if (open !== expanded) {
                            captureProjectLayout();
                            store.toggleProjectExpanded(project.id);
                          }
                        }}
                      >
                        <div
                          data-project-row
                          className="group flex items-center rounded-lg"
                        >
                          <CollapsibleTrigger asChild>
                            <button
                              type="button"
                              data-thread-item
                              className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-navigation transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span
                                className="relative size-4 shrink-0"
                                aria-hidden="true"
                              >
                                <FolderOpen
                                  className={`absolute inset-0 size-4 text-navigation transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
                                    expanded
                                      ? 'scale-100 opacity-100'
                                      : 'scale-75 opacity-0'
                                  }`}
                                />
                                <Folder
                                  className={`absolute inset-0 size-4 text-navigation transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
                                    expanded
                                      ? 'scale-75 opacity-0'
                                      : 'scale-100 opacity-100'
                                  }`}
                                />
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm font-normal">
                                {project.name}
                              </span>
                            </button>
                          </CollapsibleTrigger>
                          <div className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              disabled={
                                workspace.busy || (active && navigationDisabled)
                              }
                              onClick={() => void startProjectTask(project.id)}
                              aria-label={`在 ${project.name} 中新建任务`}
                              title={`在 ${project.name} 中新建任务`}
                            >
                              <Plus aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              className="text-tertiary hover:text-destructive"
                              disabled={
                                workspace.busy ||
                                project.threadIds.some((threadId) =>
                                  store.navigator.runningThreadIds.includes(
                                    threadId,
                                  ),
                                )
                              }
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeleteError(null);
                                setDeleteRequest({
                                  kind: 'project',
                                  projectId: project.id,
                                  name: project.name,
                                });
                              }}
                              aria-label={`从列表移除项目：${project.name}`}
                              title={`从列表移除项目：${project.name}`}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                        <CollapsibleContent className="project-disclosure-content">
                          <DeferredThreadList
                            open={expanded}
                            threadCount={project.threadIds.length}
                            render={(renderedThreadCount) =>
                              renderThreadList(
                                project.threadIds,
                                project.threadTitles,
                                active,
                                (threadId) =>
                                  selectProjectThread(project.id, threadId),
                                'project',
                                true,
                                renderedThreadCount,
                              )
                            }
                          />
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  })}
                </div>
              ) : (
                <p className="px-2 py-1 text-sm font-normal leading-normal text-tertiary">
                  还没有项目
                </p>
              )}
            </section>

            <section
              data-project-layout-item="chat-section"
              aria-labelledby="chat-section-title"
            >
              <SectionHeading
                id="chat-section-title"
                label="聊天"
                actionLabel="新建聊天"
                disabled={
                  workspace.busy || (chatActive && navigationDisabled)
                }
                onAction={() => void startChat()}
              />
              {renderThreadList(
                chatThreadIds,
                workspace.state.chatTitles ?? {},
                chatActive,
                selectChatThread,
                'chat',
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
        {footer ? (
          <div className="shrink-0 border-t p-2">{footer}</div>
        ) : null}
      </nav>

      <Dialog
        open={store.rename.request !== null}
        onOpenChange={(open) => {
          if (!open) {
            store.cancelThreadRename();
          }
        }}
      >
        <DialogContent className="max-w-md p-5">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void store.confirmThreadRename();
            }}
          >
            <DialogTitle className="text-sm font-medium">
              重命名对话
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-secondary">
              使用一个简短、可识别的名称，方便稍后找回这个对话。
            </DialogDescription>
            <Input
              className="mt-4"
              value={store.rename.draft}
              maxLength={80}
              disabled={store.rename.pending}
              autoFocus
              aria-label="对话名称"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                store.setRenameDraft(event.currentTarget.value);
              }}
            />
            {store.rename.error ? (
              <p className="mt-2 text-sm text-destructive" role="alert">
                {store.rename.error}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={store.rename.pending}
                onClick={store.cancelThreadRename}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  store.rename.pending || !store.rename.canSave
                }
              >
                {store.rename.pending ? (
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {store.rename.pending ? '正在保存…' : '保存'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open && !deletePending) {
            setDeleteRequest(null);
            setDeleteError(null);
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
            <AlertDialogTitle>
              {deleteRequest?.kind === 'project'
                ? '从列表移除这个项目？'
                : deleteRequest?.workspaceKind === 'chat'
                  ? '删除这个对话和本地文件？'
                : '删除这个对话？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteRequest?.kind === 'project'
                ? `只会从项目列表移除“${deleteRequest.name}”，不会删除本地文件或历史会话。重新打开该文件夹即可恢复。`
                : deleteRequest?.workspaceKind === 'chat'
                  ? `删除“${deleteRequest.title}”后无法恢复，对应的本地聊天文件夹及其中所有文件也会被永久删除。`
                : `删除“${deleteRequest?.title ?? '新对话'}”后无法恢复，确定要继续吗？`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel asChild>
              <Button
                ref={cancelDeleteRef}
                type="button"
                variant="outline"
                disabled={deletePending}
              >
                取消
              </Button>
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deletePending}
              onClick={() => void confirmDelete()}
            >
              {deletePending ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {deletePending
                ? deleteRequest?.kind === 'project'
                  ? '正在移除…'
                  : '正在删除…'
                : deleteRequest?.kind === 'project'
                  ? '移除'
                  : deleteRequest?.workspaceKind === 'chat'
                    ? '删除对话和文件'
                    : '删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const NavigatorSurfaceButton = ({
  active,
  icon: Icon,
  label,
  onClick,
}: Readonly<{
  active: boolean;
  icon: typeof LibraryBig;
  label: string;
  onClick?: () => void;
}>) => (
  <button
    type="button"
    aria-current={active ? 'page' : undefined}
    className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      active
        ? 'bg-link/10 font-medium text-link'
        : 'text-navigation hover:bg-surface hover:text-foreground'
    }`}
    onClick={onClick}
  >
    <Icon className="size-4" aria-hidden="true" />
    <span>{label}</span>
  </button>
);

type SectionHeadingProps = Readonly<{
  id: string;
  label: string;
  actionLabel: string;
  disabled: boolean;
  onAction: () => void;
}>;

const SectionHeading = ({
  id,
  label,
  actionLabel,
  disabled,
  onAction,
}: SectionHeadingProps) => (
  <div className="mb-1 flex h-7 items-center px-2 text-sm font-normal">
    <span id={id} className="min-w-0 flex-1 text-navigation-heading">
      {label}
    </span>
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="text-tertiary hover:text-foreground"
      disabled={disabled}
      onClick={onAction}
      aria-label={actionLabel}
      title={actionLabel}
    >
      <Plus aria-hidden="true" />
    </Button>
  </div>
);

type ThreadButtonProps = Readonly<{
  threadId: string;
  title?: string;
  current: boolean;
  status: ThreadNavigationStatus;
  disabled: boolean;
  renameDisabled: boolean;
  deleteDisabled: boolean;
  pendingMutation: ThreadStore['navigator']['pendingMutation'];
  onSelect: (threadId: string) => Promise<void>;
  onRequestRename: (threadId: string) => void;
  onRequestDelete: (threadId: string) => void;
}>;

const ThreadButton = ({
  threadId,
  title,
  current,
  status,
  disabled,
  renameDisabled,
  deleteDisabled,
  pendingMutation,
  onSelect,
  onRequestRename,
  onRequestDelete,
}: ThreadButtonProps) => {
  const label = title ?? '新对话';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-thread-row
          className={`group/session grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-stretch overflow-hidden rounded-lg ${
            current
              ? 'bg-link/10 text-link'
              : 'text-navigation hover:bg-surface hover:text-foreground'
          }`}
        >
          <button
            type="button"
            tabIndex={disabled ? -1 : 0}
            data-thread-item
            aria-current={current ? 'page' : undefined}
            aria-busy={status === 'opening' || status === 'running'}
            aria-label={`${current ? 'Current ' : ''}${label}`}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled) {
                void onSelect(threadId);
              }
            }}
            className="flex h-9 min-w-0 flex-1 cursor-pointer items-center rounded-l-lg px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default"
          >
            <span
              className={`min-w-0 flex-1 truncate text-sm ${current ? 'font-medium' : 'font-normal'}`}
            >
              {label}
            </span>
          </button>
          <div
            data-thread-actions
            className="flex min-w-fit shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100"
          >
            <ThreadActionButton
              label={`删除会话：${label}`}
              active={
                pendingMutation?.kind === 'delete' &&
                pendingMutation.threadId === threadId
              }
              disabled={deleteDisabled}
              destructive
              onClick={() => onRequestDelete(threadId)}
            >
              <Trash2 aria-hidden="true" />
            </ThreadActionButton>
          </div>
          <ThreadStatusIndicator status={status} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem
          disabled={renameDisabled}
          onSelect={() => onRequestRename(threadId)}
        >
          重命名聊天
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const ThreadStatusIndicator = ({
  status,
}: Readonly<{ status: ThreadNavigationStatus }>) => {
  switch (status) {
    case 'inputRequired':
      return (
        <span
          className="mr-2 inline-flex h-5 shrink-0 self-center items-center gap-1 rounded-full border border-process/30 bg-background px-1.5 text-[11px] font-medium text-process"
          role="status"
          title="等待你的回答"
        >
          <CircleHelp className="size-3" aria-hidden="true" />
          待回答
        </span>
      );
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
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
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
