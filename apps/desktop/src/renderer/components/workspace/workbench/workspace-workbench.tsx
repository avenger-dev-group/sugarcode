import { FolderCog, RefreshCw, X } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';

import { FileInspector } from './file-inspector';
import { FileTree } from './file-tree';
import { useStore } from './use-store';

export const WorkspaceWorkbench = () => {
  const store = useStore();
  const label =
    store.state.status === 'ready'
      ? store.state.name ?? 'Workspace'
      : 'Choose workspace';

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-w-0 max-w-44"
        onClick={() => store.setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={store.open}
        title={label}
      >
        <FolderCog aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Button>
      {store.open ? (
        <aside
          className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[42rem] flex-col border-l bg-background shadow-[-24px_0_70px_var(--shadow-soft)] sm:inset-y-3 sm:right-3 sm:rounded-2xl sm:border"
          role="dialog"
          aria-modal="false"
          aria-label="Workspace explorer"
        >
          <header className="flex min-w-0 items-center gap-3 border-b px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-tertiary">
                Workspace dossier
              </p>
              <p className="truncate text-sm font-medium" title={store.state.name}>
                {label}
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={store.state.status !== 'ready'}
              onClick={() => void store.refresh()}
              aria-label="Refresh workspace"
            >
              <RefreshCw aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => store.setOpen(false)}
              aria-label="Close workspace explorer"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          {store.state.status !== 'ready' ? (
            <div className="flex flex-1 flex-col items-start justify-center px-8">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-tertiary">
                Local authority
              </p>
              <h2 className="mt-3 text-2xl font-medium tracking-[-0.035em]">
                Bind a project directory.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-[22px] text-secondary">
                SugarCode opens one local folder without following links. Agent tools, commands, Instructions, Skills, and this explorer then share that root.
              </p>
              {store.error ? (
                <p className="mt-4 text-xs text-destructive" role="alert">
                  {store.error}
                </p>
              ) : null}
              <Button
                type="button"
                className="mt-6"
                disabled={store.state.status === 'selecting'}
                onClick={() => void store.chooseWorkspace()}
              >
                <FolderCog aria-hidden="true" />
                {store.state.status === 'selecting'
                  ? 'Opening workspace…'
                  : 'Choose local folder'}
              </Button>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,38%)_minmax(0,1fr)]">
              <section className="min-h-0 overflow-auto border-b px-2 py-2" aria-label="Workspace file tree">
                <FileTree store={store} />
              </section>
              <FileInspector document={store.document} />
            </div>
          )}
        </aside>
      ) : null}
    </>
  );
};
