import { FolderOpen, RefreshCw } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import { FileTree } from './file-tree';
import { useStore } from './use-store';

export const WorkspaceWorkbench = ({
  activePath,
  onOpenFile,
}: Readonly<{
  activePath?: string;
  onOpenFile?: (path: string) => void;
}>) => {
  const store = useStore(onOpenFile, activePath);
  const label =
    store.state.status === 'ready'
      ? store.state.name ?? 'Workspace'
      : 'Choose workspace';

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label="Workspace explorer"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FolderOpen
          className="size-4 shrink-0 text-tertiary"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 truncate text-sm" title={store.state.name}>
          {label}
        </p>
        <Button
          type="button"
          variant="ghost"
          disabled={store.state.status !== 'ready'}
          onClick={() => void store.refresh()}
          aria-label="刷新工作区文件"
        >
          <RefreshCw aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={store.state.status === 'selecting'}
          onClick={() => void store.chooseWorkspace()}
          aria-label={
            store.state.kind === 'chat'
              ? '打开项目'
              : store.state.status === 'ready'
                ? '切换项目'
                : '打开项目'
          }
        >
          <FolderOpen aria-hidden="true" />
        </Button>
      </header>

      {store.state.status !== 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="grid size-10 place-items-center rounded-xl border bg-surface text-tertiary">
            <FolderOpen className="size-4" aria-hidden="true" />
          </div>
          <h2 className="mt-4 text-sm font-medium">打开项目文件夹</h2>
          <p className="mt-2 max-w-56 text-xs leading-5 text-secondary">
            项目文件与聊天生成文件都会在各自受约束的目录中显示。
          </p>
          {store.error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {store.error}
            </p>
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
      ) : (
        <section
          className="min-h-0 flex-1 overflow-auto px-1.5 py-2"
          aria-label="Workspace file tree"
        >
          <FileTree store={store} />
          {store.error ? (
            <p className="mx-2 mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
              {store.error}
            </p>
          ) : null}
        </section>
      )}
    </section>
  );
};
