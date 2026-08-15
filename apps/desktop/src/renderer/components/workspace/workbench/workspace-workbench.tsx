import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useState,
} from 'react';
import {
  ChevronRight,
  FileCode2,
  FolderOpen,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { WorkspaceDocument } from '@/renderer/components/workspace/review/workspace-document';
import { GitWorkbench } from '@/renderer/components/workspace/git/git-workbench';

import { FileTree } from './file-tree';
import { useStore } from './use-store';

const fileName = (path: string): string =>
  path.split(/[\\/]/u).at(-1) ?? path;

const MAX_OPEN_FILE_TABS = 16;

type WorkspaceWorkbenchProps = Readonly<{
  requestKey?: number;
  requestedPath?: string;
}>;

const WorkspaceWorkbenchView = ({
  requestKey,
  requestedPath,
}: WorkspaceWorkbenchProps) => {
  const [openPaths, setOpenPaths] = useState<readonly string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const openDocument = useCallback((path: string): void => {
    setOpenPaths((current) => {
      if (current.includes(path)) {
        return current;
      }
      const retained = current.length >= MAX_OPEN_FILE_TABS
        ? current.slice(current.length - MAX_OPEN_FILE_TABS + 1)
        : current;
      return [...retained, path];
    });
    setActivePath(path);
  }, []);
  const store = useStore(openDocument, activePath ?? undefined);

  useEffect(() => {
    if (requestedPath) {
      openDocument(requestedPath);
    }
  }, [openDocument, requestKey, requestedPath]);

  const closeDocument = (path: string): void => {
    setOpenPaths((current) => {
      const index = current.indexOf(path);
      const next = current.filter((entry) => entry !== path);
      if (activePath === path) {
        setActivePath(next[Math.min(index, next.length - 1)] ?? null);
      }
      return next;
    });
  };

  const breadcrumb = activePath?.split(/[\\/]/u) ?? [];
  const workspaceLabel =
    store.state.status === 'ready'
      ? store.state.name ?? 'Workspace'
      : '项目文件';

  if (store.state.status !== 'ready') {
    return (
      <section className="flex h-full min-h-0 flex-col bg-background" aria-label="项目文件">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="grid size-11 place-items-center rounded-2xl border bg-surface text-tertiary shadow-sm">
            <FolderOpen className="size-4" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-sm font-medium">打开项目文件夹</h2>
          <p className="mt-2 max-w-60 text-xs leading-5 text-secondary">
            选择项目后，可在右侧文件树中浏览，并用标签同时查看多个文件。
          </p>
          {store.error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">{store.error}</p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="mt-5"
            disabled={store.state.status === 'selecting'}
            onClick={() => void store.chooseWorkspace()}
          >
            <FolderOpen aria-hidden="true" />
            {store.state.status === 'selecting' ? '正在打开…' : '选择文件夹'}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="项目文件">
      <div className="flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b bg-surface/35 px-2 pt-1">
        {openPaths.length === 0 ? (
          <span className="flex h-8 items-center gap-2 px-2.5 text-xs text-tertiary">
            <FileCode2 className="size-3.5" aria-hidden="true" />
            选择一个文件
          </span>
        ) : null}
        {openPaths.map((path) => {
          const active = activePath === path;
          return (
            <div
              key={path}
              className={`group flex h-8 min-w-28 max-w-48 shrink-0 items-center rounded-t-lg border border-b-0 ${
                active
                  ? 'border-border bg-background text-foreground'
                  : 'border-transparent text-secondary hover:bg-background/65'
              }`}
            >
              <button
                type="button"
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 pr-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                title={path}
                onClick={() => setActivePath(path)}
              >
                <FileCode2 className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                <span className="truncate">{fileName(path)}</span>
              </button>
              <button
                type="button"
                aria-label={`关闭 ${fileName(path)}`}
                className="mr-1 grid size-5 shrink-0 place-items-center rounded text-tertiary opacity-60 hover:bg-surface-hover hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => closeDocument(path)}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex h-10 shrink-0 items-center border-b px-3">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs text-secondary">
          <span className="shrink-0 font-medium text-foreground">{workspaceLabel}</span>
          {breadcrumb.map((part, index) => (
            <span key={`${part}:${index}`} className="flex min-w-0 items-center">
              <ChevronRight className="mx-1 size-3 shrink-0 text-tertiary" aria-hidden="true" />
              <span className={`truncate ${index === breadcrumb.length - 1 ? 'text-foreground' : ''}`}>
                {part}
              </span>
            </span>
          ))}
        </div>
        <GitWorkbench />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={() => void store.chooseWorkspace()}
          aria-label="切换项目"
          title="切换项目"
        >
          <FolderOpen aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {openPaths.length === 0 ? (
            <div className="grid h-full place-items-center px-8 text-center">
              <div>
                <FileCode2 className="mx-auto size-6 text-tertiary" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium">从右侧选择文件</p>
                <p className="mt-1.5 text-xs text-tertiary">文件会在这里以标签方式打开，重复选择不会创建副本。</p>
              </div>
            </div>
          ) : (
            openPaths.map((path) => (
              <div key={path} className={`${activePath === path ? 'block' : 'hidden'} h-full min-h-0`}>
                <WorkspaceDocument path={path} showHeader={false} />
              </div>
            ))
          )}
        </div>

        <aside className="flex w-[min(40%,17rem)] min-w-48 shrink-0 flex-col border-l bg-surface/20" aria-label="项目文件树">
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
            <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border bg-background px-2 focus-within:border-link/55 focus-within:ring-2 focus-within:ring-ring/15">
              <Search className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选文件…"
                aria-label="筛选项目文件"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-tertiary"
              />
            </label>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              onClick={() => void store.refresh()}
              aria-label="刷新项目文件"
              title="刷新"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 py-2">
            <FileTree store={store} query={deferredFilter} />
            {store.error ? (
              <p className="mx-2 mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
                {store.error}
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </section>
  );
};

export const WorkspaceWorkbench = memo(WorkspaceWorkbenchView);
