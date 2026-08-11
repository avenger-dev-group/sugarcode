import { FileCode2, LoaderCircle, RefreshCw } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { FileInspector } from '@/renderer/components/workspace/workbench/file-inspector';

import { useStore } from './use-store';

export const WorkspaceDocument = ({ path }: Readonly<{ path: string }>) => {
  const store = useStore(path);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`文件预览：${path}`}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileCode2 className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-secondary" title={path}>
          {path}
        </code>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={store.loading}
          onClick={() => void store.reload()}
          aria-label="重新读取文件"
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </header>
      {store.loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-process" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          正在读取文件…
        </div>
      ) : store.error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-sm text-destructive" role="alert">
          {store.error}
        </div>
      ) : (
        <FileInspector document={store.document} />
      )}
    </section>
  );
};
